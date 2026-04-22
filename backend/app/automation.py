from __future__ import annotations

import base64
import json
import logging
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from app.audit_repo import append_audit_event
from app.content_locale import normalize_content_lang
from app.effective_settings import effective_content_language, effective_llm_provider, effective_openai_model
from app.code_chat_api import MAX_IMAGE_SUMMARY_CHARS
from app.impact_repo import save_impact_analysis_run
from app.issue_poster import post_issue_comment, set_issue_labels
from app.issue_rules_repo import get_issue_reply_rules
from app.indexer import _repo_dir, clone_or_pull, collect_code_files, normalize_index_path
from app.project_issue_repo import (
    append_issue_message,
    get_project_issue,
    update_issue_auto_label_result,
    update_issue_labels,
    update_issue_reply_state,
)
from app.llm_client import get_llm_client
from app.llm_usage import record_llm_usage
from app.vector_store import _extract_llm_description_from_document, get_vector_store

logger = logging.getLogger(__name__)


DIFF_HIGH_RISK_KEYWORDS: tuple[str, ...] = (
    "auth",
    "permission",
    "security",
    "payment",
    "billing",
    "migration",
    "database",
    "schema",
    "login",
    "token",
    "secret",
    "credential",
)

DIFF_MEDIUM_RISK_KEYWORDS: tuple[str, ...] = (
    "api",
    "service",
    "store",
    "worker",
    "index",
    "query",
    "settings",
    "route",
    "controller",
    "webhook",
    "queue",
    "job",
    "retry",
    "timeout",
    "cache",
    "state",
)

AUTO_REPLY_BLOCKLIST = (
    "security",
    "vulnerability",
    "legal",
    "invoice",
    "billing",
    "privacy",
    "gdpr",
    "password",
    "credential",
    "secret",
)
MAX_ISSUE_IMAGE_SUMMARY_COUNT = 3
MAX_ISSUE_IMAGE_BYTES = 5 * 1024 * 1024


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _run_git(repo_path: Path, *args: str) -> str:
    cmd = ["git", "-C", str(repo_path), *args]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=30)
    if res.returncode != 0:
        raise RuntimeError((res.stderr or res.stdout or "git command failed").strip())
    return (res.stdout or "").strip()


def _git_changed_files(repo_path: Path, base_commit: str, head_commit: str) -> list[str]:
    if not base_commit or not head_commit:
        return []
    out = _run_git(repo_path, "diff", "--name-only", f"{base_commit}..{head_commit}")
    return [normalize_index_path(line.strip()) for line in out.splitlines() if line.strip()]


def _git_commit_subject(repo_path: Path, commit_sha: str) -> str:
    if not commit_sha:
        return ""
    return _run_git(repo_path, "log", "-1", "--pretty=%s", commit_sha)


def _git_name_status(repo_path: Path, base_commit: str, head_commit: str) -> list[dict[str, str]]:
    if not base_commit or not head_commit:
        return []
    out = _run_git(repo_path, "diff", "--name-status", f"{base_commit}..{head_commit}")
    rows: list[dict[str, str]] = []
    for line in out.splitlines():
        parts = [part.strip() for part in line.split("\t") if part.strip()]
        if len(parts) < 2:
            continue
        status = parts[0].upper()
        path = normalize_index_path(parts[-1])
        previous_path = normalize_index_path(parts[1]) if status.startswith("R") and len(parts) >= 3 else ""
        rows.append({"status": status, "path": path, "previous_path": previous_path})
    return rows


def _git_numstat(repo_path: Path, base_commit: str, head_commit: str) -> list[dict[str, Any]]:
    if not base_commit or not head_commit:
        return []
    out = _run_git(repo_path, "diff", "--numstat", f"{base_commit}..{head_commit}")
    rows: list[dict[str, Any]] = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added_raw, deleted_raw, path_raw = parts[0].strip(), parts[1].strip(), parts[2].strip()
        added = int(added_raw) if added_raw.isdigit() else 0
        deleted = int(deleted_raw) if deleted_raw.isdigit() else 0
        rows.append(
            {
                "path": normalize_index_path(path_raw),
                "added": added,
                "deleted": deleted,
                "changes": added + deleted,
            }
        )
    return rows


def _git_file_patch(repo_path: Path, base_commit: str, head_commit: str, path: str) -> str:
    if not base_commit or not head_commit or not path.strip():
        return ""
    try:
        return _run_git(repo_path, "diff", "--unified=0", f"{base_commit}..{head_commit}", "--", path)
    except Exception:
        return ""


def _normalize_risk_level(value: Any, fallback: str = "low") -> str:
    risk = str(value or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")
    if risk in {"critical", "highest", "high", "高", "高风险", "3"}:
        return "high"
    if risk in {"moderate", "medium", "med", "warning", "warn", "中", "中等", "中风险", "2"}:
        return "medium"
    if risk in {"low", "minor", "safe", "info", "低", "低风险", "1"}:
        return "low"
    fallback_text = str(fallback or "low").strip().lower()
    return fallback_text if fallback_text in {"high", "medium", "low"} else "low"


def _path_segments(path: str) -> list[str]:
    normalized = normalize_index_path(path)
    return [segment for segment in normalized.split("/") if segment]


MODULE_LABEL_CONTAINER_SEGMENTS: set[str] = {
    "src",
    "app",
    "lib",
    "pkg",
    "internal",
    "cmd",
    "packages",
    "services",
    "modules",
}

MODULE_LABEL_IGNORED_LEAF_SEGMENTS: set[str] = {
    "components",
    "pages",
    "views",
    "routes",
    "controllers",
    "handlers",
    "utils",
    "helpers",
    "common",
    "shared",
}

TOP_LEVEL_ROLE_HINTS: dict[str, str] = {
    "docs": "documentation",
    "scripts": "automation scripts",
    "tests": "tests",
    "test": "tests",
    "spec": "tests",
    "specs": "tests",
    "migrations": "migrations",
    "deploy": "deployment",
    "ops": "operations",
    "infra": "infrastructure",
    "config": "configuration",
}


AREA_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("issue", "issue automation"),
    ("webhook", "webhook ingestion"),
    ("impact", "commit impact analysis"),
    ("index", "repository indexing"),
    ("vector", "vector search"),
    ("queue", "background job queue"),
    ("job", "background jobs"),
    ("setting", "settings management"),
    ("config", "configuration"),
    ("auth", "authentication"),
    ("repo", "repository sync"),
    ("project-detail", "project detail UI"),
    ("llm", "llm integration"),
    ("usage", "usage tracking"),
)


def _module_label_for_path(path: str) -> str:
    normalized = normalize_index_path(path)
    segments = _path_segments(normalized)
    if not segments:
        return normalized or "unknown"

    lowered_segments = [segment.lower() for segment in segments]
    first = lowered_segments[0]
    if first in TOP_LEVEL_ROLE_HINTS and len(segments) == 1:
        return TOP_LEVEL_ROLE_HINTS[first]

    selected: list[str] = []
    index = 0
    while index < len(segments) and len(selected) < 2:
        raw_segment = segments[index]
        lowered = lowered_segments[index]

        if not selected:
            selected.append(raw_segment)
            index += 1
            continue

        if lowered in MODULE_LABEL_CONTAINER_SEGMENTS:
            index += 1
            continue

        if lowered in MODULE_LABEL_IGNORED_LEAF_SEGMENTS and index + 1 < len(segments):
            next_segment = segments[index + 1]
            selected.append(next_segment)
            index += 2
            continue

        selected.append(raw_segment)
        index += 1

    if len(selected) == 1 and first in TOP_LEVEL_ROLE_HINTS:
        return TOP_LEVEL_ROLE_HINTS[first]

    cleaned = [segment.replace("-", " ").replace("_", " ").strip() for segment in selected if segment.strip()]
    if cleaned:
        return " / ".join(cleaned[:2])
    return normalized or "unknown"


def _infer_changed_modules(changed_files: list[str], limit: int = 8) -> list[str]:
    modules: list[str] = []
    seen: set[str] = set()
    for path in changed_files:
        label = _module_label_for_path(path)
        if label in seen:
            continue
        seen.add(label)
        modules.append(label)
        if len(modules) >= limit:
            break
    return modules


def _infer_affected_areas(changed_files: list[str], changed_modules: list[str], limit: int = 8) -> list[str]:
    joined = "\n".join(changed_files + changed_modules).lower()
    areas: list[str] = []
    seen: set[str] = set()
    for keyword, label in AREA_KEYWORDS:
        if keyword in joined and label not in seen:
            seen.add(label)
            areas.append(label)

    if not areas:
        for module in changed_modules:
            module_text = str(module).strip()
            if not module_text or module_text.lower() in seen:
                continue
            seen.add(module_text.lower())
            areas.append(module_text)
            if len(areas) >= limit:
                break

    if not areas:
        top_levels = []
        for path in changed_files:
            segments = _path_segments(path)
            if not segments:
                continue
            top = segments[0].replace("-", " ").replace("_", " ").strip()
            if not top:
                continue
            top_levels.append(top)
        for top in list(dict.fromkeys(top_levels))[:limit]:
            areas.append(f"{top} area")

    if not areas:
        areas.append("repository structure")
    return areas[:limit]


def _infer_cross_system_impact(changed_files: list[str], changed_modules: list[str], affected_areas: list[str]) -> list[str]:
    impacts: list[str] = []
    top_levels = {
        _path_segments(path)[0].lower()
        for path in changed_files
        if _path_segments(path)
    }
    joined_values = changed_files + changed_modules + affected_areas
    lowered_values = [value.lower() for value in joined_values]

    if len(top_levels) >= 2:
        impacts.append("Spans multiple top-level areas of the repository")
    if any("webhook" in value or "event" in value for value in lowered_values):
        impacts.append("Can affect external event intake and downstream automation")
    if any("queue" in value or "job" in value or "worker" in value for value in lowered_values):
        impacts.append("May change background execution, scheduling, or retry behavior")
    if any("index" in value or "vector" in value or "search" in value or "retrieve" in value for value in lowered_values):
        impacts.append("May influence indexing, retrieval, or analysis quality")
    if any("setting" in value or "config" in value or "env" in value for value in lowered_values):
        impacts.append("Configuration-sensitive behavior should be revalidated")
    if any("api" in value or "contract" in value or "schema" in value for value in lowered_values):
        impacts.append("Contract compatibility across callers and consumers should be rechecked")
    return impacts[:4]


DIFF_FACT_PATTERNS: tuple[tuple[str, str, str, int], ...] = (
    (r"^[+-].*\b(enqueue|job_type|retry|worker|queue)\b", "job_orchestration", "job_orchestration", 2),
    (r"^[+-].*\b(webhook|issue_comment|issue event|push event|signature|payload)\b", "webhook_contract", "webhook_contract", 2),
    (r"^[+-].*\b(status|state|should_trigger|should_auto_post|if\s+not|elif|else:)\b", "state_transition", "state_transition", 2),
    (r"^[+-].*\b(return\s+\{|response|json|Field\(|model_dump|model_validate)\b", "api_contract", "api_contract", 2),
    (r"^[+-].*\b(insert|update|delete|sqlite|database|schema|sql)\b", "data_persistence", "data_persistence", 3),
    (r"^[+-].*\b(fetch|apiJson|AbortController|setInterval|clearInterval|localStorage|useEffect)\b", "frontend_async", "frontend_async", 2),
    (r"^[+-].*\b(content lang|locale|language|i18n|translate|fallback)\b", "localization", "localization", 1),
    (r"^[+-].*\b(auth|permission|token|secret|credential|password)\b", "security_sensitive", "security_sensitive", 3),
)


RISK_REASON_TEMPLATES: dict[str, str] = {
    "job_orchestration": "本次改动触及任务入队、执行或重试链路，若参数或状态传递不一致，可能导致任务漏触发、重复执行或失败恢复异常。",
    "webhook_contract": "本次改动触及 webhook / 事件载荷解析逻辑，若不同 provider 的 payload 字段兼容性不足，可能出现事件漏消费、字段缺失或自动化链路未触发。",
    "state_transition": "本次改动调整了状态判断或触发条件，若分支覆盖不完整，可能导致行为误判、重复触发或应触发流程被跳过。",
    "api_contract": "本次改动涉及接口字段或返回结构，若调用方未同步兼容，前后端之间可能出现字段缺失、空态异常或展示错误。",
    "data_persistence": "本次改动触及持久化逻辑，若写入字段、查询条件或兼容处理不完整，可能导致历史数据读取异常、状态不一致或结果丢失。",
    "frontend_async": "本次改动涉及前端异步请求、轮询或本地状态管理，若并发与清理处理不完整，可能出现旧请求覆盖新结果、重复轮询或页面闪动。",
    "localization": "本次改动涉及语言映射或回退逻辑，可能导致默认语言不符合预期、局部文案语言混用或结果展示不一致。",
    "security_sensitive": "本次改动涉及认证、凭据或敏感权限逻辑，若校验或回退路径处理不严谨，可能扩大访问范围或暴露敏感行为风险。",
}


VALIDATION_TEMPLATES: dict[str, str] = {
    "job_orchestration": "验证相关任务是否按预期入队、执行、结束，并检查失败后的重试或取消行为是否正常。",
    "webhook_contract": "分别回放主要 provider 的对应 webhook 事件，确认关键字段提取、自动化触发与审计记录都符合预期。",
    "state_transition": "覆盖 opened / updated / closed / retry 等关键状态分支，确认边界条件下不会误触发或漏触发。",
    "api_contract": "联调前后端或上下游调用方，确认新增/变更字段在旧数据、空值和异常响应下都能正确处理。",
    "data_persistence": "验证新增写入、更新与读取场景，确认历史数据兼容、幂等更新和失败回滚符合预期。",
    "frontend_async": "通过快速切换筛选、打开关闭弹窗或反复刷新页面，确认请求取消、定时器清理和页面状态一致性正常。",
    "localization": "分别在中英文或不同内容语言配置下验证展示结果，确认默认回退与局部文本语言一致。",
    "security_sensitive": "验证未授权、边界权限和敏感输入场景，确认校验生效且不会因回退逻辑放宽约束。",
}


FILE_ROLE_RULES: tuple[tuple[str, str], ...] = (
    ("backend/app/automation.py", "提交影响分析生成与自动化链路"),
    ("backend/app/webhook.py", "Webhook 入口与任务触发链路"),
    ("backend/app/content_locale.py", "内容语言与回退映射"),
    ("frontend/src/pages/project-detail/ProjectImpactTab.tsx", "项目详情中的提交影响展示页"),
    ("frontend/src/i18n/strings.ts", "前端多语言文案映射"),
    ("frontend/src/pages/jobs/", "任务中心与执行过程展示"),
)


CATEGORY_LABELS: dict[str, str] = {
    "job_orchestration": "任务编排",
    "webhook_contract": "Webhook 载荷",
    "state_transition": "状态分支",
    "api_contract": "接口契约",
    "data_persistence": "数据持久化",
    "frontend_async": "前端异步状态",
    "localization": "国际化与回退",
    "security_sensitive": "安全敏感逻辑",
}


IMPACT_I18N: dict[str, dict[str, Any]] = {
    "zh": {
        "category_labels": {
            "job_orchestration": "任务编排",
            "webhook_contract": "Webhook 载荷",
            "state_transition": "状态分支",
            "api_contract": "接口契约",
            "data_persistence": "数据持久化",
            "frontend_async": "前端异步状态",
            "localization": "国际化与回退",
            "security_sensitive": "安全敏感逻辑",
        },
        "default_backend_app_role": "后端业务逻辑",
        "default_frontend_page_role": "前端页面逻辑",
        "default_frontend_app_role": "前端应用逻辑",
        "change_summary": {
            "frontend_async": "这次改动涉及前端异步请求、轮询节奏或状态同步方式。",
            "api_contract": "这次改动触及接口字段组织、响应结构或数据模型映射。",
            "state_transition": "这次改动调整了状态判断、触发条件或控制流分支。",
            "job_orchestration": "这次改动涉及任务编排、执行顺序或后台流程衔接。",
            "webhook_contract": "这次改动涉及事件载荷解析或外部事件接入约定。",
            "data_persistence": "这次改动涉及数据写入、读取或持久化处理逻辑。",
            "localization": "这次改动涉及语言映射、翻译回退或多语言内容组织。",
            "security_sensitive": "这次改动涉及认证、权限或敏感能力边界。",
            "category_generic": "这次改动主要落在{category_text}相关行为上。",
            "patch_generic": "这次改动主要体现在该文件内部实现细节的重组与调整。",
            "fallback": "这次改动涉及该文件，但目前提取出的行为特征仍然有限。",
        },
        "impact_summary": {
            "api_and_frontend": "这类改动会同时波及页面取数与渲染逻辑，联调时要重点确认字段兼容、空值处理和状态一致性。",
            "api_contract": "这类改动容易影响上下游读取结果时的字段兼容、默认值处理和旧数据容忍度。",
            "job_orchestration_or_webhook": "这类改动更容易放大到自动化触发、执行顺序和结果记录链路，建议按真实流程回放验证。",
            "localization": "这类改动主要影响展示层文案与翻译回退，风险通常集中在可读性和一致性，而不是核心业务行为。",
            "security_sensitive": "这类改动可能影响访问控制、凭据处理或敏感能力边界，需要重点确认副作用是否被正确约束。",
            "data_persistence": "这类改动可能影响历史数据兼容、读写一致性以及失败后的恢复或回滚行为。",
            "state_transition": "这类改动可能影响状态流转、分支覆盖和触发条件，需重点确认边界场景是否仍符合预期。",
            "large_change": "该文件改动面较大，更适合按关键场景扩大回归范围，避免只验证主路径而遗漏边界行为。",
            "patch_generic": "该文件实现已经发生变化，建议结合实际调用链路确认影响是停留在局部，还是会继续向上下游扩散。",
            "fallback": "当前还没提炼出足够明确的影响模式，建议结合真实调用链路继续确认。",
        },
        "fact_descriptions": {
            "job_orchestration": "涉及任务入队、执行或重试相关逻辑变更",
            "webhook_contract": "涉及 webhook 或事件载荷解析逻辑变更",
            "state_transition": "涉及状态判断、触发条件或控制流变更",
            "api_contract": "涉及接口字段、返回结构或数据模型变更",
            "data_persistence": "涉及数据库写入、查询或持久化逻辑变更",
            "frontend_async": "涉及前端异步请求、轮询或本地状态管理变更",
            "localization": "涉及语言映射、国际化或回退逻辑变更",
            "security_sensitive": "涉及认证、凭据或敏感权限逻辑变更",
            "high_risk_path": "文件路径命中敏感能力域，需要重点复核安全与权限相关副作用",
            "large_file_change": "单文件改动行数较大，回归验证范围可能扩大",
            "medium_file_change": "单文件存在中等规模改动，建议关注边界分支与兼容性",
            "definition_change": "包含函数、类型或类定义调整，可能改变调用方契约或内部行为",
            "exception_change": "包含异常处理分支调整，需确认失败路径与回退行为",
        },
        "change_fact_format": "{path} 出现 {status} 变更（+{added}/-{deleted}），{change_summary}",
        "change_fact_format_no_summary": "{path} 出现 {status} 变更（+{added}/-{deleted}）",
        "risk_reason_with_change": "{path} 中“{change_summary}”这类变更，意味着{impact_summary}",
        "risk_reason_without_change": "{path} 的改动意味着{impact_summary}",
        "cross_system_both": "本次改动同时覆盖后端结果生成与前端结果消费，项目影响分析的数据生成链路和页面呈现链路需要一起验证。",
        "cross_system_both_risk": "前后端同时变更时，如果结果结构、字段命名或空值处理没有同步，页面可能出现数据缺失、展示错位或解释不一致。",
        "strings_only_direct": "本次提交主要影响前端展示文案与翻译映射，属于低风险展示层变更。",
        "strings_only_risk": "当前改动集中在翻译键和值本身，应重点检查新增字段标题、提示文案与多语言回退是否一致，不应夸大为核心业务逻辑风险。",
        "verification_fallback": [
            "验证直接改动模块及其相邻流程的回归行为",
            "验证本次提交触及的高风险自动化、接口或数据链路",
            "结合受影响模块检查跨模块副作用是否符合预期",
        ],
        "risk_reasons": RISK_REASON_TEMPLATES,
        "validation_templates": VALIDATION_TEMPLATES,
    },
    "en": {
        "category_labels": {
            "job_orchestration": "job orchestration",
            "webhook_contract": "webhook payload handling",
            "state_transition": "state transitions",
            "api_contract": "API contract",
            "data_persistence": "data persistence",
            "frontend_async": "frontend async state",
            "localization": "localization and fallback",
            "security_sensitive": "security-sensitive logic",
        },
        "default_backend_app_role": "backend business logic",
        "default_frontend_page_role": "frontend page logic",
        "default_frontend_app_role": "frontend application logic",
        "change_summary": {
            "frontend_async": "This change touches frontend async requests, polling cadence, or state synchronization behavior.",
            "api_contract": "This change touches API field organization, response structure, or data model mapping.",
            "state_transition": "This change adjusts state checks, trigger conditions, or control-flow branches.",
            "job_orchestration": "This change touches job orchestration, execution order, or background workflow coordination.",
            "webhook_contract": "This change touches event payload parsing or external event integration contracts.",
            "data_persistence": "This change touches data writes, reads, or persistence handling logic.",
            "localization": "This change touches language mapping, translation fallback, or multilingual content organization.",
            "security_sensitive": "This change touches authentication, authorization, or sensitive capability boundaries.",
            "category_generic": "This change mainly affects behavior related to {category_text}.",
            "patch_generic": "This change is primarily reflected in internal implementation refactoring and adjustments within this file.",
            "fallback": "This change touches the file, but the extracted behavioral signals are still limited.",
        },
        "impact_summary": {
            "api_and_frontend": "This kind of change can affect both data fetching and rendering logic, so integration testing should focus on field compatibility, null handling, and state consistency.",
            "api_contract": "This kind of change can affect field compatibility, default handling, and tolerance for older data across upstream and downstream consumers.",
            "job_orchestration_or_webhook": "This kind of change is more likely to expand into automation triggering, execution order, and result-recording flows, so it should be replayed and validated against real workflows.",
            "localization": "This kind of change mainly affects display-layer copy and translation fallback. The risk is usually concentrated in readability and consistency rather than core business behavior.",
            "security_sensitive": "This kind of change can affect access control, credential handling, or sensitive capability boundaries, so side effects should be reviewed carefully.",
            "data_persistence": "This kind of change can affect historical compatibility, read/write consistency, and recovery or rollback behavior after failures.",
            "state_transition": "This kind of change can affect state progression, branch coverage, and trigger conditions, so boundary scenarios should be verified carefully.",
            "large_change": "This file changed substantially, so broader scenario-based regression coverage is more appropriate than validating only the happy path.",
            "patch_generic": "Implementation in this file has changed. Validate whether the impact stays local or continues to propagate across upstream and downstream flows.",
            "fallback": "There is not enough signal yet to derive a sharper impact pattern, so validate it against the real call flow.",
        },
        "fact_descriptions": {
            "job_orchestration": "Touches logic related to job enqueueing, execution, or retries",
            "webhook_contract": "Touches webhook or event payload parsing logic",
            "state_transition": "Touches state checks, trigger conditions, or control flow",
            "api_contract": "Touches API fields, response structure, or data models",
            "data_persistence": "Touches database writes, queries, or persistence logic",
            "frontend_async": "Touches frontend async requests, polling, or local state management",
            "localization": "Touches language mapping, i18n, or fallback logic",
            "security_sensitive": "Touches authentication, credentials, or sensitive permission logic",
            "high_risk_path": "The file path hits a sensitive capability area and should receive closer review for security and permission side effects",
            "large_file_change": "The file changed substantially, so regression scope may need to expand",
            "medium_file_change": "The file has a medium-sized change set, so boundary branches and compatibility should be reviewed",
            "definition_change": "Includes changes to functions, types, or class definitions, which may alter caller contracts or internal behavior",
            "exception_change": "Includes changes to exception-handling branches, so failure paths and fallback behavior should be verified",
        },
        "change_fact_format": "{path} changed with status {status} (+{added}/-{deleted}), {change_summary}",
        "change_fact_format_no_summary": "{path} changed with status {status} (+{added}/-{deleted})",
        "risk_reason_with_change": "In {path}, a change like \"{change_summary}\" implies that {impact_summary}",
        "risk_reason_without_change": "The change in {path} implies that {impact_summary}",
        "cross_system_both": "This change spans both backend result generation and frontend result consumption, so the data-generation path and the page rendering path for project impact analysis should be validated together.",
        "cross_system_both_risk": "When frontend and backend change together, any mismatch in result shape, field naming, or null handling can cause missing data, broken rendering, or inconsistent interpretation in the UI.",
        "strings_only_direct": "This commit mainly affects frontend display copy and translation mappings, which is a low-risk presentation-layer change.",
        "strings_only_risk": "The current change is concentrated in translation keys and values, so the focus should be on whether new field titles, helper copy, and multilingual fallback stay consistent rather than overstating it as core business-logic risk.",
        "verification_fallback": [
            "Validate regression behavior in the directly changed modules and their adjacent flows",
            "Validate the higher-risk automation, API, or data paths touched by this commit",
            "Check whether cross-module side effects remain within expectations for the affected modules",
        ],
        "risk_reasons": {
            "job_orchestration": "This change touches job enqueueing, execution, or retry flows. If parameters or state propagation are inconsistent, it can lead to missed triggers, duplicate execution, or broken failure recovery.",
            "webhook_contract": "This change touches webhook or event payload parsing. If payload compatibility across providers is incomplete, events may be dropped, fields may be missing, or downstream automation may fail to trigger.",
            "state_transition": "This change adjusts state checks or trigger conditions. If branch coverage is incomplete, it can cause misclassification, duplicate triggering, or skipped flows that should have run.",
            "api_contract": "This change touches API fields or response shape. If consumers are not updated compatibly, upstream and downstream systems may see missing fields, empty-state issues, or rendering errors.",
            "data_persistence": "This change touches persistence logic. If written fields, query conditions, or compatibility handling are incomplete, historical reads, state consistency, or result integrity may be affected.",
            "frontend_async": "This change touches frontend async requests, polling, or local state management. If concurrency or cleanup handling is incomplete, stale responses may overwrite fresh results, polling may duplicate, or the page may flicker.",
            "localization": "This change touches language mapping or fallback logic, which may cause the default language to differ from expectations, mixed-language copy in some areas, or inconsistent result presentation.",
            "security_sensitive": "This change touches authentication, credentials, or sensitive permission logic. If validation or fallback paths are not handled carefully, it can broaden access or expose sensitive behavior risks.",
        },
        "validation_templates": {
            "job_orchestration": "Validate that related jobs are enqueued, executed, and finished as expected, and verify retry or cancellation behavior after failures.",
            "webhook_contract": "Replay representative webhook events from the main providers and verify field extraction, automation triggering, and audit logging.",
            "state_transition": "Cover key state branches such as opened, updated, closed, and retry to verify that boundary conditions neither over-trigger nor miss expected flows.",
            "api_contract": "Integration-test upstream and downstream consumers to verify that new or changed fields are handled correctly for existing data, null values, and error responses.",
            "data_persistence": "Validate create, update, and read paths, and confirm historical compatibility, idempotent updates, and failure rollback behavior.",
            "frontend_async": "Rapidly switch filters, open and close dialogs, or refresh repeatedly to verify request cancellation, timer cleanup, and UI state consistency.",
            "localization": "Validate rendered output under Chinese and English or other configured content-language settings, and confirm default fallback behavior and local copy consistency.",
            "security_sensitive": "Validate unauthorized, boundary-permission, and sensitive-input scenarios to confirm that checks remain enforced and are not weakened by fallback behavior.",
        },
    },
}


def _impact_lang() -> str:
    return normalize_content_lang(effective_content_language())


def _impact_messages(lang: str | None = None) -> dict[str, Any]:
    normalized = normalize_content_lang(lang or _impact_lang())
    return IMPACT_I18N.get(normalized, IMPACT_I18N["zh"])


def _file_role_for_path(path: str) -> str:
    normalized = normalize_index_path(path)
    lowered = normalized.lower()
    messages = _impact_messages()
    if lowered.startswith("backend/app/"):
        return messages["default_backend_app_role"]
    if lowered.startswith("frontend/src/pages/"):
        return messages["default_frontend_page_role"]
    if lowered.startswith("frontend/src/"):
        return messages["default_frontend_app_role"]
    return _module_label_for_path(path)


def _summarize_categories(categories: list[str]) -> str:
    labels_map = _impact_messages()["category_labels"]
    labels = [labels_map.get(item, item) for item in categories if str(item).strip()]
    separator = "、" if _impact_lang() == "zh" else ", "
    return separator.join(labels[:3])


def _extract_patch_evidence(patch: str, limit: int = 3) -> list[str]:
    evidence: list[str] = []
    for raw in patch.splitlines():
        line = raw.strip()
        if not line or line.startswith("+++") or line.startswith("---") or line.startswith("@@"):
            continue
        if not (line.startswith("+") or line.startswith("-")):
            continue
        text = line[1:].strip()
        if len(text) < 4:
            continue
        if text in {"{", "}", "(", ")", "[", "]"}:
            continue
        evidence.append(text[:180])
        if len(evidence) >= limit:
            break
    return evidence


def _infer_file_change_summary(path: str, categories: list[str], patch: str) -> str:
    category_text = _summarize_categories(categories)
    messages = _impact_messages()["change_summary"]
    if "frontend_async" in categories:
        return messages["frontend_async"]
    if "api_contract" in categories:
        return messages["api_contract"]
    if "state_transition" in categories:
        return messages["state_transition"]
    if "job_orchestration" in categories:
        return messages["job_orchestration"]
    if "webhook_contract" in categories:
        return messages["webhook_contract"]
    if "data_persistence" in categories:
        return messages["data_persistence"]
    if "localization" in categories:
        return messages["localization"]
    if "security_sensitive" in categories:
        return messages["security_sensitive"]
    if category_text:
        return str(messages["category_generic"]).format(category_text=category_text)
    if patch.strip():
        return messages["patch_generic"]
    return messages["fallback"]


def _infer_file_impact_summary(path: str, categories: list[str], patch: str, total_changes: int) -> str:
    messages = _impact_messages()["impact_summary"]
    if "api_contract" in categories and "frontend_async" in categories:
        return messages["api_and_frontend"]
    if "api_contract" in categories:
        return messages["api_contract"]
    if "job_orchestration" in categories or "webhook_contract" in categories:
        return messages["job_orchestration_or_webhook"]
    if "localization" in categories:
        return messages["localization"]
    if "security_sensitive" in categories:
        return messages["security_sensitive"]
    if "data_persistence" in categories:
        return messages["data_persistence"]
    if "state_transition" in categories:
        return messages["state_transition"]
    if total_changes >= 80:
        return messages["large_change"]
    if patch.strip():
        return messages["patch_generic"]
    return messages["fallback"]


def _normalize_file_facts(diff_analysis: dict[str, Any]) -> list[dict[str, Any]]:
    rows = diff_analysis.get("file_facts") or []
    return [row for row in rows if isinstance(row, dict)]


def _extract_diff_facts(repo_dir: Path, base_commit: str, commit_sha: str, changed_files: list[str]) -> dict[str, Any]:
    name_status = _git_name_status(repo_dir, base_commit, commit_sha)
    numstat_rows = _git_numstat(repo_dir, base_commit, commit_sha)
    numstat_by_path = {str(row.get("path") or ""): row for row in numstat_rows}
    status_by_path = {str(row.get("path") or ""): row for row in name_status}
    file_facts: list[dict[str, Any]] = []
    category_scores: dict[str, int] = {}
    category_examples: dict[str, list[str]] = {}

    for path in changed_files[:12]:
        patch = _git_file_patch(repo_dir, base_commit, commit_sha, path)
        lowered_patch = patch.lower()
        matched_categories: list[str] = []
        fact_lines: list[str] = []
        score = 0
        fact_messages = _impact_messages()["fact_descriptions"]
        for pattern, category, description_key, weight in DIFF_FACT_PATTERNS:
            if not patch:
                continue
            if re.search(pattern, lowered_patch, flags=re.MULTILINE):
                matched_categories.append(category)
                fact_lines.append(str(fact_messages.get(description_key, description_key)))
                score += weight
                category_scores[category] = category_scores.get(category, 0) + weight
                category_examples.setdefault(category, []).append(path)
        if any(keyword in path.lower() for keyword in DIFF_HIGH_RISK_KEYWORDS):
            matched_categories.append("security_sensitive")
            fact_lines.append(str(fact_messages["high_risk_path"]))
            score += 2
            category_scores["security_sensitive"] = category_scores.get("security_sensitive", 0) + 2
            category_examples.setdefault("security_sensitive", []).append(path)
        elif any(keyword in path.lower() for keyword in DIFF_MEDIUM_RISK_KEYWORDS):
            score += 1

        stat = numstat_by_path.get(path, {})
        status_row = status_by_path.get(path, {})
        total_changes = int(stat.get("changes") or 0)
        if total_changes >= 80:
            fact_lines.append(str(fact_messages["large_file_change"]))
            score += 2
        elif total_changes >= 30:
            fact_lines.append(str(fact_messages["medium_file_change"]))
            score += 1

        if patch and re.search(r"^[+-].*\b(function|def |const |type |class |interface )\b", patch, flags=re.MULTILINE):
            fact_lines.append(str(fact_messages["definition_change"]))
            score += 1
        if patch and re.search(r"^[+-].*\btry:|^[+-].*\bexcept\b|^[+-].*\bcatch\b", patch, flags=re.MULTILINE):
            fact_lines.append(str(fact_messages["exception_change"]))
            score += 1

        role = _file_role_for_path(path)
        categories = sorted(set(matched_categories))
        evidence = _extract_patch_evidence(patch)
        change_summary = _infer_file_change_summary(path, categories, patch)
        impact_summary = _infer_file_impact_summary(path, categories, patch, total_changes)
        file_facts.append(
            {
                "path": path,
                "status": str(status_row.get("status") or "M"),
                "previous_path": str(status_row.get("previous_path") or ""),
                "added": int(stat.get("added") or 0),
                "deleted": int(stat.get("deleted") or 0),
                "changes": total_changes,
                "matched_categories": categories,
                "facts": fact_lines[:5],
                "risk_score": score,
                "file_role": role,
                "change_summary": change_summary,
                "impact_summary": impact_summary,
                "evidence": evidence,
            }
        )

    top_categories = [
        {"category": category, "score": score, "examples": sorted(set(category_examples.get(category, [])))[:3]}
        for category, score in sorted(category_scores.items(), key=lambda item: item[1], reverse=True)
    ]
    return {"file_facts": file_facts, "top_categories": top_categories}


def _build_change_facts(diff_analysis: dict[str, Any]) -> list[str]:
    facts: list[str] = []
    messages = _impact_messages()
    for row in _normalize_file_facts(diff_analysis):
        path = str(row.get("path") or "")
        status = str(row.get("status") or "M")
        added = int(row.get("added") or 0)
        deleted = int(row.get("deleted") or 0)
        change_summary = str(row.get("change_summary") or "").strip()
        if change_summary:
            text = str(messages["change_fact_format"]).format(
                path=path,
                status=status,
                added=added,
                deleted=deleted,
                change_summary=change_summary,
            )
        else:
            text = str(messages["change_fact_format_no_summary"]).format(path=path, status=status, added=added, deleted=deleted)
        facts.append(text)
        if len(facts) >= 6:
            break
    return facts


def _build_diff_based_risks(diff_analysis: dict[str, Any], cross_system_impact: list[str]) -> tuple[str, list[str], list[str], list[str]]:
    file_facts = sorted(
        _normalize_file_facts(diff_analysis),
        key=lambda row: (int(row.get("risk_score") or 0), int(row.get("changes") or 0)),
        reverse=True,
    )
    messages = _impact_messages()
    validation_templates = messages["validation_templates"]
    direct_impacts: list[str] = []
    risk_reasons: list[str] = []
    validation_checks: list[str] = []
    score = 0
    has_frontend = any(str(row.get("path") or "").startswith("frontend/") for row in file_facts)
    has_backend = any(str(row.get("path") or "").startswith("backend/") for row in file_facts)
    impact_separator = "：" if _impact_lang() == "zh" else ": "

    for row in file_facts[:5]:
        path = str(row.get("path") or "").strip()
        impact_summary = str(row.get("impact_summary") or "").strip()
        change_summary = str(row.get("change_summary") or "").strip()
        categories = [str(item) for item in (row.get("matched_categories") or []) if str(item).strip()]
        score += int(row.get("risk_score") or 0)
        if impact_summary:
            direct_impacts.append(f"{path}{impact_separator}{impact_summary}")
        if change_summary and impact_summary:
            risk_reasons.append(str(messages["risk_reason_with_change"]).format(path=path, change_summary=change_summary, impact_summary=impact_summary))
        elif impact_summary:
            risk_reasons.append(str(messages["risk_reason_without_change"]).format(path=path, impact_summary=impact_summary))
        for category in categories[:2]:
            validation = validation_templates.get(category)
            if validation:
                validation_checks.append(validation)

    if has_frontend and has_backend:
        direct_impacts.append(str(messages["cross_system_both"]))
        risk_reasons.append(str(messages["cross_system_both_risk"]))

    if file_facts and all(str(row.get("path") or "").endswith("strings.ts") for row in file_facts):
        direct_impacts = [str(messages["strings_only_direct"])]
        risk_reasons = [str(messages["strings_only_risk"])]

    if cross_system_impact:
        direct_impacts.extend(cross_system_impact[:1])

    direct_impacts = list(dict.fromkeys(direct_impacts))[:5]
    risk_reasons = list(dict.fromkeys(risk_reasons))[:5]
    validation_checks = list(dict.fromkeys(validation_checks))[:5]

    if score >= 9:
        risk_level = "high"
    elif score >= 4:
        risk_level = "medium"
    else:
        risk_level = "low"
    return risk_level, risk_reasons, validation_checks, direct_impacts


def _build_global_context_queries(
    changed_files: list[str],
    changed_modules: list[str],
    affected_areas: list[str],
    commit_subject: str,
) -> list[str]:
    queries: list[str] = []
    for value in changed_files[:4]:
        if value.strip():
            queries.append(value.strip())
    for value in changed_modules[:3]:
        if value.strip():
            queries.append(value.strip())
    for value in affected_areas[:3]:
        if value.strip():
            queries.append(value.strip())
    if commit_subject.strip():
        queries.append(commit_subject.strip())
    dedup: list[str] = []
    seen: set[str] = set()
    for value in queries:
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        dedup.append(value)
    return dedup[:10]


def _recall_related_context(
    project_id: str,
    changed_files: list[str],
    changed_modules: list[str],
    affected_areas: list[str],
    commit_subject: str,
    top_k: int = 10,
) -> list[dict[str, Any]]:
    store = get_vector_store()
    queries = _build_global_context_queries(changed_files, changed_modules, affected_areas, commit_subject)
    results: list[dict[str, Any]] = []
    for query in queries:
        try:
            hits = store.query(project_id=project_id, query_texts=[query], n_results=max(2, min(top_k, 4)))
        except Exception:
            continue
        docs = hits.get("results") or []
        for row in docs:
            meta = row.get("metadata") or {}
            results.append(
                {
                    "query": query,
                    "path": str(meta.get("path") or ""),
                    "name": str(meta.get("name") or ""),
                    "kind": str(meta.get("kind") or ""),
                    "module": _module_label_for_path(str(meta.get("path") or "")),
                    "score": row.get("score"),
                    "summary": _extract_llm_description_from_document(str(row.get("document") or ""))[:240],
                }
            )
    dedup: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for row in sorted(results, key=lambda item: float(item.get("score") or 0), reverse=True):
        key = (row.get("path", ""), row.get("name", ""), row.get("kind", ""))
        if key in seen:
            continue
        seen.add(key)
        dedup.append(row)
        if len(dedup) >= top_k:
            break
    return dedup


def analyze_commit_impact(
    *,
    project_id: str,
    repo_url: str,
    branch: str,
    commit_sha: str,
    parent_commit_sha: str,
    author: str,
    message: str,
    trigger_source: str,
    job_id: str,
    repo_path: str = "",
    ensure_repo_latest: bool = False,
) -> dict[str, Any]:
    repo_dir = Path(repo_path).expanduser() if str(repo_path or "").strip() else _repo_dir(project_id)
    if ensure_repo_latest:
        if not str(repo_url or "").strip():
            raise RuntimeError("repo_url is required when ensure_repo_latest is enabled")
        repo_dir = clone_or_pull(repo_url, project_id)
    if not repo_dir.exists():
        raise RuntimeError(f"repository mirror not found: {repo_dir}")
    changed_files = _git_changed_files(repo_dir, parent_commit_sha, commit_sha)
    if not changed_files and commit_sha:
        changed_files = [normalize_index_path(p) for p in _run_git(repo_dir, "show", "--pretty=", "--name-only", commit_sha).splitlines() if p.strip()]
    commit_subject = message.strip() or _git_commit_subject(repo_dir, commit_sha)
    all_files = collect_code_files(repo_dir)
    normalized_all_files = [normalize_index_path(path) for path, _ in all_files]
    available_paths = set(normalized_all_files)
    changed_existing_files = [path for path in changed_files if path in available_paths]
    changed_modules = _infer_changed_modules(changed_files)
    affected_areas = _infer_affected_areas(changed_files, changed_modules)
    cross_system_impact = _infer_cross_system_impact(changed_files, changed_modules, affected_areas)
    diff_analysis = _extract_diff_facts(repo_dir, parent_commit_sha, commit_sha, changed_files)
    change_facts = _build_change_facts(diff_analysis)
    risk_level, risk_reasons, validation_checks, direct_impacts = _build_diff_based_risks(diff_analysis, cross_system_impact)
    related_context = _recall_related_context(project_id, changed_files, changed_modules, affected_areas, commit_subject)
    repository_snapshot = {
        "total_indexable_files": len(normalized_all_files),
        "top_level_areas": sorted({_path_segments(path)[0] for path in normalized_all_files if _path_segments(path)})[:12],
    }
    verification_focus = validation_checks or list(_impact_messages()["verification_fallback"])
    summary = {
        "project_id": project_id,
        "repo_path": str(repo_dir),
        "branch": branch,
        "commit_sha": commit_sha,
        "base_commit_sha": parent_commit_sha,
        "author": author,
        "commit_message": commit_subject,
        "changed_files": changed_files,
        "changed_file_count": len(changed_files),
        "changed_modules": changed_modules,
        "affected_areas": affected_areas,
        "cross_system_impact": cross_system_impact,
        "diff_analysis": diff_analysis,
        "change_facts": change_facts,
        "direct_impacts": direct_impacts,
        "risk_reasons": risk_reasons,
        "indexed_file_hits": changed_existing_files[:20],
        "repository_snapshot": repository_snapshot,
        "related_context": related_context,
        "risk_level": risk_level,
        "verification_focus": verification_focus,
        "recommended_actions": verification_focus,
    }

    client = get_llm_client()
    if client:
        output_lang = "English" if normalize_content_lang(effective_content_language()) == "en" else "Chinese"
        system = (
            "You are a senior staff engineer performing project-wide commit impact analysis. "
            "Base your reasoning on structured file-level diff facts first, then infer the likely blast radius across modules, workflows, automation, and repository boundaries. "
            "Return JSON with the fields: summary, impact_scope, risks, tests, reviewers, confidence, and optionally risk_level, changed_modules, affected_areas, cross_system_impact, verification_focus, change_facts, direct_impacts, risk_reasons. "
            "Every risk and impact statement must be traceable to one or more files in diff_analysis.file_facts, especially file_role, change_summary, impact_summary, or evidence. "
            "Do not output generic statements that could apply to any commit. If a change is mostly UI copy or display wiring, say so explicitly and keep the risk scoped to display behavior. "
            "The summary field is an executive analysis brief, not a file-by-file change log. Summarize the overall nature of the change, the end-to-end impact, and the overall risk judgment. "
            "For summary, do not enumerate file paths unless absolutely necessary, do not narrate implementation steps, and do not write like release notes or commit descriptions. "
            "Prefer 2 compact paragraphs or 2-3 concise sentences: first explain what kind of change this is overall, then explain the overall impact/risk and what should be validated. "
            "The summary should sound like an overall assessment for reviewers, not like a diff walkthrough. "
            "If you provide risk_level, it must be exactly one of: high, medium, low. Do not use any other wording, translations, or casing for risk_level. "
            f"Write all natural-language values in {output_lang}, but keep risk_level in English enum form."
        )
        user = json.dumps(
            {
                "project_id": project_id,
                "branch": branch,
                "commit_sha": commit_sha,
                "base_commit_sha": parent_commit_sha,
                "author": author,
                "message": commit_subject,
                "changed_files": changed_files,
                "changed_modules": changed_modules,
                "affected_areas": affected_areas,
                "cross_system_impact": cross_system_impact,
                "diff_analysis": diff_analysis,
                "change_facts": change_facts,
                "direct_impacts": direct_impacts,
                "risk_reasons": risk_reasons,
                "repository_snapshot": repository_snapshot,
                "related_context": related_context,
                "verification_focus": verification_focus,
            },
            ensure_ascii=False,
        )
        try:
            raw = client.chat(system=system, user=user, feature="impact_analysis", project_id=project_id)
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                summary["llm"] = parsed
                summary["confidence"] = parsed.get("confidence")
                risk_level = _normalize_risk_level(parsed.get("risk_level"), fallback=risk_level)
                if isinstance(summary.get("llm"), dict):
                    summary["llm"]["risk_level"] = risk_level
                summary["risk_level"] = risk_level
        except Exception as exc:
            logger.warning("impact analysis llm failed: %s", exc)
            append_audit_event(
                event_type="impact_analysis.llm_failed",
                actor="system",
                route="automation.analyze_commit_impact",
                method="POST",
                resource_type="impact_analysis",
                resource_id=job_id,
                status="error",
                payload={"project_id": project_id, "commit_sha": commit_sha, "error": str(exc)},
            )
    else:
        record_llm_usage(
            provider=effective_llm_provider(),
            model=effective_openai_model(),
            feature="impact_analysis_skipped",
            success=False,
            project_id=project_id,
        )

    save_impact_analysis_run(
        job_id=job_id,
        project_id=project_id,
        repo_path=str(repo_dir),
        repo_url=repo_url,
        branch=branch,
        commit_sha=commit_sha,
        base_commit_sha=parent_commit_sha,
        trigger_source=trigger_source,
        risk_level=risk_level,
        status="completed",
        summary=summary,
    )
    append_audit_event(
        event_type="impact_analysis.completed",
        actor="system",
        route="automation.analyze_commit_impact",
        method="POST",
        resource_type="impact_analysis",
        resource_id=job_id,
        status="ok",
        payload={
            "project_id": project_id,
            "commit_sha": commit_sha,
            "base_commit_sha": parent_commit_sha,
            "risk_level": risk_level,
            "changed_file_count": len(changed_files),
        },
    )
    return summary


def _normalize_issue_messages(payload: dict[str, Any]) -> list[dict[str, Any]]:
    value = payload.get("messages") or []
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        body = str(item.get("body") or item.get("content") or "")
        if not body.strip():
            continue
        role = str(item.get("role") or "user").strip().lower()
        normalized.append(
            {
                "id": str(item.get("id") or "").strip(),
                "role": role if role in {"user", "assistant"} else "user",
                "kind": str(item.get("kind") or "comment").strip().lower() or "comment",
                "author": str(item.get("author") or item.get("sender") or "").strip(),
                "body": body,
                "created_at": str(item.get("created_at") or item.get("time") or "").strip(),
                "url": str(item.get("url") or "").strip(),
                "provider": str(item.get("provider") or payload.get("provider") or "").strip(),
                "source": str(item.get("source") or "").strip(),
                "status": str(item.get("status") or "").strip(),
            }
        )
    return normalized


def _normalize_issue_event(payload: dict[str, Any]) -> dict[str, Any]:
    messages = _normalize_issue_messages(payload)
    latest_user_message = next(
        (message for message in reversed(messages) if str(message.get("role") or "").strip().lower() != "assistant"),
        None,
    )
    latest_comment_body = str(payload.get("comment_body") or "").strip() or str((latest_user_message or {}).get("body") or "").strip()
    comments = [str(x).strip() for x in (payload.get("comments") or []) if str(x).strip()]
    if not comments and messages:
        comments = [
            str(message.get("body") or "").strip()
            for message in messages
            if str(message.get("role") or "").strip().lower() != "assistant" and str(message.get("kind") or "") == "comment"
        ]
    return {
        "provider": str(payload.get("provider") or "generic").strip().lower() or "generic",
        "project_id": str(payload.get("project_id") or "").strip(),
        "project_name": str(payload.get("project_name") or "").strip(),
        "repo_url": str(payload.get("repo_url") or "").strip(),
        "issue_number": str(payload.get("issue_number") or payload.get("iid") or "").strip(),
        "issue_url": str(payload.get("issue_url") or payload.get("web_url") or "").strip(),
        "title": str(payload.get("title") or "").strip(),
        "body": str(payload.get("body") or payload.get("description") or "").strip(),
        "issue_body": str(payload.get("issue_body") or payload.get("body") or payload.get("description") or "").strip(),
        "comment_body": latest_comment_body,
        "event_kind": str(payload.get("event_kind") or "issue").strip().lower() or "issue",
        "issue_created_at": str(payload.get("issue_created_at") or payload.get("created_at") or "").strip(),
        "event_created_at": str(payload.get("event_created_at") or payload.get("created_at") or "").strip(),
        "comment_id": str(payload.get("comment_id") or "").strip(),
        "comment_url": str(payload.get("comment_url") or "").strip(),
        "author": str(payload.get("author") or payload.get("user") or "").strip(),
        "issue_author": str(payload.get("issue_author") or payload.get("author") or payload.get("user") or "").strip(),
        "comment_author": str(payload.get("comment_author") or payload.get("author") or payload.get("user") or "").strip(),
        "labels": [str(x).strip() for x in (payload.get("labels") or []) if str(x).strip()],
        "action": str(payload.get("action") or "opened").strip().lower() or "opened",
        "comments": comments,
        "messages": messages,
        "latest_user_message": latest_user_message or {},
        "auto_post": bool(payload.get("auto_post", False)),
        "source": str(payload.get("source") or "webhook").strip() or "webhook",
    }


def _issue_conversation_text(issue: dict[str, Any]) -> str:
    messages = issue.get("messages") or []
    if isinstance(messages, list) and messages:
        texts = [str(message.get("body") or "") for message in messages if str(message.get("body") or "").strip()]
        if texts:
            return "\n".join(texts).lower()
    texts = [str(issue.get("title") or ""), str(issue.get("issue_body") or issue.get("body") or "")]
    comment_body = str(issue.get("comment_body") or "").strip()
    if comment_body:
        texts.append(comment_body)
    else:
        texts.extend(str(comment or "") for comment in (issue.get("comments") or []))
    return "\n".join(texts).lower()


def _issue_image_summary_system(output_lang: str) -> str:
    return (
        "You are an image understanding assistant for issue triage and auto reply generation. "
        "Describe the image briefly and focus on details that help reply to a software issue. "
        "If it is a screenshot, mention visible UI text, buttons, errors, statuses, code, logs, file names, or layout clues. "
        "Do not hallucinate unreadable details. Keep it under 200 words. "
        f"Reply in {output_lang}."
    )


def _extract_markdown_image_urls(text: str) -> list[str]:
    pattern = re.compile(r"!\[[^\]]*\]\((https?://[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)", re.IGNORECASE)
    urls: list[str] = []
    for match in pattern.finditer(str(text or "")):
        url = str(match.group(1) or "").strip()
        if url and url not in urls:
            urls.append(url)
    return urls


def _collect_issue_image_urls(issue: dict[str, Any]) -> list[str]:
    urls: list[str] = []

    def _add_from_text(value: Any) -> None:
        for url in _extract_markdown_image_urls(str(value or "")):
            if url not in urls:
                urls.append(url)

    _add_from_text(issue.get("issue_body") or issue.get("body") or "")
    _add_from_text(issue.get("comment_body") or "")
    for comment in issue.get("comments") or []:
        _add_from_text(comment)
    for message in issue.get("messages") or []:
        if isinstance(message, dict):
            _add_from_text(message.get("body") or "")

    return urls[:MAX_ISSUE_IMAGE_SUMMARY_COUNT]


def _guess_image_mime_type(content_type: str, url: str) -> str:
    normalized_content_type = str(content_type or "").split(";", 1)[0].strip().lower()
    if normalized_content_type.startswith("image/"):
        return normalized_content_type
    lowered_url = str(url or "").lower()
    if lowered_url.endswith(".png"):
        return "image/png"
    if lowered_url.endswith(".jpg") or lowered_url.endswith(".jpeg"):
        return "image/jpeg"
    if lowered_url.endswith(".webp"):
        return "image/webp"
    if lowered_url.endswith(".gif"):
        return "image/gif"
    return "image/png"


def _download_issue_image_as_data_url(url: str) -> tuple[str, str] | None:
    try:
        with httpx.Client(timeout=20, follow_redirects=True) as client:
            response = client.get(url)
            response.raise_for_status()
            content = response.content
            if not content or len(content) > MAX_ISSUE_IMAGE_BYTES:
                return None
            mime_type = _guess_image_mime_type(response.headers.get("content-type", ""), url)
            data_url = f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}"
            return mime_type, data_url
    except Exception as exc:
        logger.warning("issue image download failed: %s", exc)
        return None


def _summarize_issue_images(client: Any, issue: dict[str, Any]) -> list[str]:
    image_urls = _collect_issue_image_urls(issue)
    if not image_urls:
        return []

    output_lang = "English" if normalize_content_lang(effective_content_language()) == "en" else "Simplified Chinese"
    summaries: list[str] = []
    for idx, url in enumerate(image_urls, start=1):
        downloaded = _download_issue_image_as_data_url(url)
        if not downloaded:
            continue
        mime_type, data_url = downloaded
        try:
            summary = client.chat_multimodal(
                _issue_image_summary_system(output_lang),
                [
                    {"type": "text", "text": "Please summarize this issue image for automatic reply generation."},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
                feature="issue_auto_reply_image_summary",
                project_id=str(issue.get("project_id") or "").strip(),
            )
        except Exception as exc:
            logger.warning("issue image summary failed: %s", exc)
            continue
        cleaned = str(summary or "").strip()[:MAX_IMAGE_SUMMARY_CHARS]
        if cleaned:
            summaries.append(f"Image {idx}:\nURL: {url}\nSummary: {cleaned}")
    return summaries


def _should_block_auto_reply(issue: dict[str, Any]) -> tuple[bool, str, list[str]]:
    text = _issue_conversation_text(issue)
    rules = get_issue_reply_rules(str(issue.get("project_id") or "").strip())
    blocked_keywords = [str(x).strip().lower() for x in (rules.get("blocked_keywords") or []) if str(x).strip()]
    human_keywords = [str(x).strip().lower() for x in (rules.get("require_human_keywords") or []) if str(x).strip()]
    for keyword in blocked_keywords or AUTO_REPLY_BLOCKLIST:
        if keyword in text:
            return True, keyword, human_keywords
    return False, "", human_keywords


def _build_issue_related_context(project_id: str, issue: dict[str, Any]) -> list[dict[str, Any]]:
    store = get_vector_store()
    latest_comment = str(issue.get("comment_body") or "").strip()
    if not latest_comment:
        comments = issue.get("comments") or []
        if isinstance(comments, list) and comments:
            latest_comment = str(comments[-1] or "")
    query_text = "\n".join(filter(None, [issue.get("title", ""), latest_comment, issue.get("issue_body", "") or issue.get("body", "")]))
    if not query_text.strip():
        return []
    try:
        rows = store.query(query_text, project_id=project_id, top_k=6)
    except Exception:
        return []
    context: list[dict[str, Any]] = []
    for row in rows:
        meta = row.get("metadata") or {}
        content = str(row.get("content") or "").strip()
        context.append(
            {
                "path": str(meta.get("path") or ""),
                "name": str(meta.get("name") or ""),
                "kind": str(meta.get("kind") or ""),
                "start_line": meta.get("start_line"),
                "end_line": meta.get("end_line"),
                "score": row.get("score"),
                "summary": _extract_llm_description_from_document(
                    content,
                    path=str(meta.get("path") or ""),
                    name=str(meta.get("name") or ""),
                ),
                "content": content[:4000],
            }
        )
    return context


def _normalize_labels(labels: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for item in labels:
        text = str(item or "").strip()
        if not text:
            continue
        lowered = text.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        normalized.append(text)
    return normalized


def _coerce_llm_recommended_labels(raw: Any, available_labels: list[str]) -> list[str]:
    if not isinstance(raw, list):
        return []
    normalized_available = {label.lower(): label for label in available_labels}
    recommended: list[str] = []
    seen: set[str] = set()
    for item in raw:
        text = str(item or "").strip()
        lowered = text.lower()
        if not text or lowered in seen or lowered not in normalized_available:
            continue
        seen.add(lowered)
        recommended.append(normalized_available[lowered])
    return recommended[:3]


def build_issue_auto_labels(issue: dict[str, Any], rules: dict[str, Any], reply_result: dict[str, Any]) -> dict[str, Any]:
    enabled = bool(rules.get("auto_label_enabled"))
    available_labels = _normalize_labels(list(rules.get("available_labels") or []))
    recommended_labels = _coerce_llm_recommended_labels(reply_result.get("recommended_labels"), available_labels)
    if enabled and bool(reply_result.get("blocked")):
        blocked_label = next((label for label in available_labels if label.lower() == "blocked"), "")
        if blocked_label:
            recommended_labels = _normalize_labels([*recommended_labels, blocked_label])
    if enabled and bool(reply_result.get("needs_human")):
        needs_human_label = next((label for label in available_labels if label.lower() == "needs-human"), "")
        if needs_human_label:
            recommended_labels = _normalize_labels([*recommended_labels, needs_human_label])
    return {
        "enabled": enabled,
        "recommended_labels": recommended_labels,
        "applied_labels": [],
        "matched_rules": [],
        "applied": False,
        "apply_error": "",
        "source": "llm",
        "updated_at": _utc_now_iso(),
    }


def apply_issue_auto_labels(*, issue: dict[str, Any], rules: dict[str, Any], auto_label_result: dict[str, Any]) -> dict[str, Any]:
    recommended_labels = _normalize_labels(list(auto_label_result.get("recommended_labels") or []))
    existing_labels = _normalize_labels(list(issue.get("labels") or []))
    merged_labels = _normalize_labels([*existing_labels, *recommended_labels])
    output = {**auto_label_result, "applied_labels": merged_labels}
    if not bool(auto_label_result.get("enabled")):
        return output
    if not bool(rules.get("auto_apply_labels")):
        return output
    if not merged_labels:
        output["applied"] = True
        return output
    result = set_issue_labels(
        provider=str(issue.get("provider") or "").strip().lower(),
        project_id=str(issue.get("project_id") or "").strip(),
        repo_url=str(issue.get("repo_url") or "").strip(),
        issue_number=str(issue.get("issue_number") or "").strip(),
        labels=merged_labels,
    )
    if not result.updated:
        output["apply_error"] = str(result.error or "failed to update issue labels")
        return output
    output["applied"] = True
    output["applied_labels"] = _normalize_labels(list(result.labels or merged_labels))
    update_issue_labels(
        project_id=str(issue.get("project_id") or "").strip(),
        provider=str(issue.get("provider") or "").strip().lower(),
        issue_number=str(issue.get("issue_number") or "").strip(),
        labels=output["applied_labels"],
        status=str(result.issue_state or issue.get("status") or ""),
    )
    return output


def generate_issue_reply(*, payload: dict[str, Any], job_id: str) -> dict[str, Any]:
    if not payload.get("messages"):
        existing_issue = get_project_issue(
            str(payload.get("project_id") or "").strip(),
            str(payload.get("provider") or "").strip().lower(),
            str(payload.get("issue_number") or payload.get("iid") or "").strip(),
        )
        if existing_issue and existing_issue.get("messages"):
            payload = {**payload, "messages": existing_issue.get("messages")}
    issue = _normalize_issue_event(payload)
    project_id = issue["project_id"]
    related_context = _build_issue_related_context(project_id, issue)
    blocked, blocked_by, human_keywords = _should_block_auto_reply(issue)
    text = _issue_conversation_text(issue)
    matched_human_keyword = next((keyword for keyword in human_keywords if keyword in text), "")
    needs_human = bool(matched_human_keyword)
    rules = get_issue_reply_rules(project_id)
    auto_post_enabled = bool(issue["auto_post"] or rules.get("auto_post_default"))
    decision_reasons: list[str] = []
    if not auto_post_enabled:
        decision_reasons.append("auto_post is disabled")
    if blocked:
        decision_reasons.append(f"blocked by keyword: {blocked_by}")
    if needs_human:
        decision_reasons.append(f"matched require_human keyword: {matched_human_keyword}")

    result: dict[str, Any] = {
        "project_id": project_id,
        "provider": issue["provider"],
        "issue_number": issue["issue_number"],
        "issue_url": issue["issue_url"],
        "repo_url": issue["repo_url"],
        "action": issue["action"],
        "related_context": related_context,
        "image_summaries": [],
        "auto_post_requested": bool(issue["auto_post"]),
        "auto_post_default": bool(rules.get("auto_post_default")),
        "auto_post_enabled": auto_post_enabled,
        "blocked": blocked,
        "blocked_by": blocked_by,
        "needs_human": needs_human,
        "human_keywords": human_keywords,
        "should_auto_post": False,
        "skip_reason": "",
        "decision_reasons": decision_reasons,
        "posted": False,
        "post_error": "",
        "provider_comment_url": "",
        "provider_comment_id": "",
        "posted_at": "",
    }
    client = get_llm_client()
    if client:
        image_summaries = _summarize_issue_images(client, issue)
        result["image_summaries"] = image_summaries
        configured_output_lang = "English" if normalize_content_lang(effective_content_language()) == "en" else "Chinese"
        system = (
            "You are an open-source project maintainer assistant and a code Q&A assistant. Prioritize answers grounded in the retrieved vector context in related_context, especially when the user asks about implementation details, file locations, function logic, call relationships, configuration, or debugging suggestions."
            "If the evidence in related_context is insufficient, say clearly that you cannot fully confirm it yet, and do not invent file names, function names, or implementation details."
            "Your reply should sound natural and human, not like a template, ticket bot, or audit report."
            "By default, reply in the same language as the user's latest question. If the latest message language is unclear, fall back to the configured output language."
            f"The configured fallback output language is {configured_output_lang}."
            "For code-related questions, answer the user's main question first, then naturally mention the supporting code evidence or likely implementation locations when helpful."
            "Do not end every reply with next-step suggestions, follow-up offers, or action proposals by default. Only include them when the user explicitly asks for guidance, troubleshooting steps, implementation advice, or when a next action is truly necessary to answer correctly."
            "Avoid stiff section headings, excessive numbering, formulaic boilerplate, and repetitive closing phrases unless the user explicitly asks for that format."
            "Decide whether the latest user message actually needs a reply in context. Do not reply to pure acknowledgements, thanks, confirmations, or comments that add no actionable question or no meaningful new information."
            "When you decide no reply is needed, set should_auto_post to false, keep needs_human false unless a human is really needed, set skip_reason to a short explanation, and keep reply as an empty string or a minimal internal draft that will not be posted."
            "You also help assign issue labels. Only choose labels from available_labels when provided. Return at most 3 labels, and return an empty list if you are uncertain."
            "Return JSON with the fields: category, summary, reply, confidence, should_auto_post, needs_human, skip_reason, recommended_labels."
        )
        user = json.dumps(
            {
                "issue": issue,
                "latest_comment": str((issue.get("latest_user_message") or {}).get("body") or issue.get("comment_body") or "").strip(),
                "latest_user_message": issue.get("latest_user_message") or {},
                "messages": issue.get("messages") or [],
                "related_context": related_context,
                "image_summaries": image_summaries,
                "reply_style": {
                    "prefer_vector_grounded_answer": True,
                    "when_code_question": "answer the user's concrete question first, then mention retrieved code evidence naturally",
                    "when_evidence_insufficient": "state uncertainty instead of guessing; ask for more context only when it is actually needed",
                    "tone": "natural, conversational, human-like",
                    "language": "match the user's latest question language",
                    "avoid": ["robotic tone", "stiff template wording", "over-structured report style", "default next-step suggestion endings", "repetitive follow-up offers"],
                },
                "policy": {
                    "auto_post_requested": bool(issue["auto_post"]),
                    "auto_post_enabled": auto_post_enabled,
                    "blocked": blocked,
                    "blocked_by": blocked_by,
                    "needs_human_by_rule": needs_human,
                    "matched_human_keyword": matched_human_keyword,
                },
                "available_labels": list(rules.get("available_labels") or []),
                "labeling_instructions": str(rules.get("labeling_instructions") or ""),
                "reply_template": str(rules.get("reply_template") or ""),
                "reply_requirements": str(rules.get("reply_requirements") or ""),
            },
            ensure_ascii=False,
        )
        try:
            raw = client.chat(system=system, user=user, feature="issue_auto_reply", project_id=project_id)
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                result.update(parsed)
        except Exception as exc:
            logger.warning("issue auto reply llm failed: %s", exc)
            result.update(
                {
                    "category": "unknown",
                    "summary": "LLM reply generation failed",
                    "reply": "",
                    "confidence": 0,
                    "should_auto_post": False,
                    "needs_human": True,
                    "skip_reason": "llm generation failed",
                    "recommended_labels": [],
                    "error": str(exc),
                }
            )
    else:
        result.update(
            {
                "category": "generic",
                "summary": "LLM unavailable",
                "reply": "",
                "confidence": 0,
                "should_auto_post": False,
                "needs_human": True,
                "skip_reason": "llm unavailable",
                "recommended_labels": [],
            }
        )

    result["should_auto_post"] = bool(auto_post_enabled and bool(result.get("should_auto_post")))
    result["needs_human"] = bool(result.get("needs_human"))
    result["skip_reason"] = str(result.get("skip_reason") or "").strip()
    if blocked:
        result["should_auto_post"] = False
        result["needs_human"] = True
        result["skip_reason"] = result["skip_reason"] or "blocked by policy"
        if "blocked by policy" not in result["decision_reasons"]:
            result["decision_reasons"].append("blocked by policy")
    if needs_human:
        result["should_auto_post"] = False
        result["needs_human"] = True
        result["skip_reason"] = result["skip_reason"] or f"matched require_human keyword: {matched_human_keyword}"
    if not auto_post_enabled:
        result["should_auto_post"] = False
        result["skip_reason"] = result["skip_reason"] or "auto_post is disabled"
    if not result["should_auto_post"] and not result["needs_human"] and not result["skip_reason"]:
        result["skip_reason"] = "llm decided no reply is needed"
        if "llm decided no reply is needed" not in result["decision_reasons"]:
            result["decision_reasons"].append("llm decided no reply is needed")

    auto_label_result = build_issue_auto_labels(issue, rules, result)
    auto_label_result = apply_issue_auto_labels(issue=issue, rules=rules, auto_label_result=auto_label_result)
    result["auto_label_result"] = auto_label_result
    update_issue_auto_label_result(
        project_id=project_id,
        provider=issue["provider"],
        issue_number=issue["issue_number"],
        auto_label_result=auto_label_result,
    )

    latest_status = "blocked" if blocked else ("needs_human" if bool(result.get("needs_human")) else ("generated" if bool(result.get("should_auto_post")) else "skipped"))
    latest_posted_at = ""
    latest_comment_url = ""
    latest_error = ""

    if result.get("should_auto_post"):
        post_result = post_issue_comment(
            provider=issue["provider"],
            project_id=project_id,
            repo_url=issue["repo_url"],
            issue_number=issue["issue_number"],
            reply=str(result.get("reply") or ""),
        )
        result.update(
            {
                "posted": post_result.posted,
                "post_error": post_result.error,
                "provider_comment_url": post_result.comment_url,
                "provider_comment_id": post_result.comment_id,
                "posted_at": post_result.posted_at,
            }
        )
        if post_result.posted:
            result["decision_reasons"].append("comment posted successfully")
        elif post_result.error:
            result["decision_reasons"].append(f"post failed: {post_result.error}")
        if post_result.posted:
            latest_status = "posted"
            latest_posted_at = post_result.posted_at
            latest_comment_url = post_result.comment_url
        else:
            latest_status = "post_failed"
            latest_error = post_result.error

    update_issue_reply_state(
        project_id=project_id,
        provider=issue["provider"],
        issue_number=issue["issue_number"],
        latest_reply_job_id=job_id,
        latest_reply_status=latest_status,
        latest_reply_preview=str(result.get("reply") or "")[:1000],
        latest_reply_posted_at=latest_posted_at,
        latest_reply_comment_url=latest_comment_url,
        latest_reply_error=latest_error,
    )
    reply_body = str(result.get("reply") or "").strip()
    if reply_body and bool(result.get("should_auto_post")):
        append_issue_message(
            project_id=project_id,
            provider=issue["provider"],
            issue_number=issue["issue_number"],
            message={
                "id": str(result.get("provider_comment_id") or f"{issue['provider']}:reply:{issue['issue_number']}:{job_id}"),
                "role": "assistant",
                "kind": "reply",
                "author": "bot",
                "body": reply_body,
                "created_at": str(result.get("posted_at") or latest_posted_at or _utc_now_iso()).strip(),
                "url": str(result.get("provider_comment_url") or latest_comment_url or "").strip(),
                "provider": issue["provider"],
                "source": "bot",
                "status": latest_status,
            },
        )

    logger.info(
        "issue reply decision job_id=%s provider=%s issue=%s should_auto_post=%s reasons=%s post_error=%s",
        job_id,
        issue["provider"],
        issue["issue_number"],
        bool(result.get("should_auto_post")),
        result.get("decision_reasons") or [],
        result.get("post_error") or "",
    )

    append_audit_event(
        event_type="issue_reply.generated",
        actor="system",
        route="automation.generate_issue_reply",
        method="POST",
        resource_type="issue_reply",
        resource_id=job_id,
        status="ok" if not result.get("error") else "error",
        payload={
            "project_id": project_id,
            "issue_number": issue["issue_number"],
            "provider": issue["provider"],
            "blocked": blocked,
            "blocked_by": blocked_by,
            "should_auto_post": bool(result.get("should_auto_post")),
            "confidence": result.get("confidence"),
            "decision_reasons": result.get("decision_reasons") or [],
            "post_error": result.get("post_error") or "",
        },
    )
    if latest_status == "posted":
        append_audit_event(
            event_type="issue_reply.posted",
            actor="system",
            route="automation.generate_issue_reply",
            method="POST",
            resource_type="issue_reply",
            resource_id=job_id,
            status="ok",
            payload={
                "project_id": project_id,
                "issue_number": issue["issue_number"],
                "provider": issue["provider"],
                "reply_preview": str(result.get("reply") or "")[:500],
                "comment_url": latest_comment_url,
            },
        )
    elif latest_status == "post_failed":
        append_audit_event(
            event_type="issue_reply.post_failed",
            actor="system",
            route="automation.generate_issue_reply",
            method="POST",
            resource_type="issue_reply",
            resource_id=job_id,
            status="error",
            payload={
                "project_id": project_id,
                "issue_number": issue["issue_number"],
                "provider": issue["provider"],
                "error": latest_error,
            },
        )
    elif blocked:
        append_audit_event(
            event_type="issue_reply.blocked",
            actor="system",
            route="automation.generate_issue_reply",
            method="POST",
            resource_type="issue_reply",
            resource_id=job_id,
            status="ok",
            payload={
                "project_id": project_id,
                "issue_number": issue["issue_number"],
                "provider": issue["provider"],
                "blocked_by": blocked_by,
            },
        )
    elif latest_status == "skipped":
        append_audit_event(
            event_type="issue_reply.skipped",
            actor="system",
            route="automation.generate_issue_reply",
            method="POST",
            resource_type="issue_reply",
            resource_id=job_id,
            status="ok",
            payload={
                "project_id": project_id,
                "issue_number": issue["issue_number"],
                "provider": issue["provider"],
                "skip_reason": str(result.get("skip_reason") or ""),
            },
        )
    return result
