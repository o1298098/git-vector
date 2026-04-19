from __future__ import annotations

import json
import logging
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.audit_repo import append_audit_event
from app.effective_settings import effective_llm_provider, effective_openai_model
from app.impact_repo import save_impact_analysis_run
from app.issue_poster import post_issue_comment
from app.issue_rules_repo import get_issue_reply_rules
from app.indexer import collect_code_files, normalize_index_path
from app.project_issue_repo import append_issue_message, get_project_issue, update_issue_reply_state
from app.llm_client import get_llm_client
from app.llm_usage import record_llm_usage
from app.vector_store import _extract_llm_description_from_document, get_vector_store

logger = logging.getLogger(__name__)


RISK_KEYWORDS: dict[str, tuple[str, ...]] = {
    "high": (
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
        "webhook",
        "queue",
    ),
    "medium": (
        "api",
        "service",
        "store",
        "worker",
        "index",
        "query",
        "settings",
        "route",
        "controller",
    ),
}

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


def _infer_risk(paths: list[str]) -> str:
    joined = "\n".join(paths).lower()
    for level in ("high", "medium"):
        if any(keyword in joined for keyword in RISK_KEYWORDS[level]):
            return level
    return "low"


def _recall_related_context(project_id: str, changed_files: list[str], top_k: int = 6) -> list[dict[str, Any]]:
    store = get_vector_store()
    results: list[dict[str, Any]] = []
    for path in changed_files[:4]:
        try:
            hits = store.query(project_id=project_id, query_texts=[path], n_results=max(1, min(top_k, 3)))
        except Exception:
            continue
        docs = hits.get("results") or []
        for row in docs:
            meta = row.get("metadata") or {}
            results.append(
                {
                    "path": str(meta.get("path") or ""),
                    "name": str(meta.get("name") or ""),
                    "kind": str(meta.get("kind") or ""),
                    "score": row.get("score"),
                }
            )
    dedup: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for row in results:
        key = (row.get("path", ""), row.get("name", ""), row.get("kind", ""))
        if key in seen:
            continue
        seen.add(key)
        dedup.append(row)
    return dedup[:top_k]


def analyze_local_commit(
    *,
    project_id: str,
    repo_path: str,
    repo_url: str,
    branch: str,
    commit_sha: str,
    parent_commit_sha: str,
    author: str,
    message: str,
    trigger_source: str,
    job_id: str,
) -> dict[str, Any]:
    repo_dir = Path(repo_path)
    changed_files = _git_changed_files(repo_dir, parent_commit_sha, commit_sha)
    if not changed_files and commit_sha:
        changed_files = [normalize_index_path(p) for p in _run_git(repo_dir, "show", "--pretty=", "--name-only", commit_sha).splitlines() if p.strip()]
    commit_subject = message.strip() or _git_commit_subject(repo_dir, commit_sha)
    all_files = collect_code_files(repo_dir)
    available_paths = {normalize_index_path(path) for path, _ in all_files}
    changed_existing_files = [path for path in changed_files if path in available_paths]
    related_context = _recall_related_context(project_id, changed_files)
    risk_level = _infer_risk(changed_files)
    summary = {
        "project_id": project_id,
        "branch": branch,
        "commit_sha": commit_sha,
        "base_commit_sha": parent_commit_sha,
        "author": author,
        "commit_message": commit_subject,
        "changed_files": changed_files,
        "changed_file_count": len(changed_files),
        "indexed_file_hits": changed_existing_files[:20],
        "related_context": related_context,
        "risk_level": risk_level,
        "recommended_actions": [
            "检查受影响模块的单元测试与集成测试",
            "优先回归与高风险路径相关的接口或流程",
            "让熟悉相关模块的 reviewer 参与评审",
        ],
    }

    client = get_llm_client()
    if client:
        system = (
            "你是资深代码评审助手。请根据提交变更和检索上下文，输出 JSON，字段包含 summary、impact_scope、risks、tests、reviewers、confidence。"
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
                "related_context": related_context,
            },
            ensure_ascii=False,
        )
        try:
            raw = client.chat(system=system, user=user, feature="impact_analysis", project_id=project_id)
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                summary["llm"] = parsed
                summary["confidence"] = parsed.get("confidence")
                risk_level = str(parsed.get("risk_level") or risk_level)
                summary["risk_level"] = risk_level
        except Exception as exc:
            logger.warning("impact analysis llm failed: %s", exc)
            append_audit_event(
                event_type="impact_analysis.llm_failed",
                actor="system",
                route="automation.analyze_local_commit",
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
        repo_path=repo_path,
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
        route="automation.analyze_local_commit",
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
        system = (
            "You are an open-source project maintainer assistant and a code Q&A assistant. Prioritize answers grounded in the retrieved vector context in related_context, especially when the user asks about implementation details, file locations, function logic, call relationships, configuration, or debugging suggestions."
            "If the evidence in related_context is insufficient, say clearly that you cannot fully confirm it yet, and do not invent file names, function names, or implementation details."
            "Your reply should sound natural and human, not like a template, ticket bot, or audit report."
            "Reply in the same language as the user's latest question. If the user writes in Chinese, reply in Chinese; if the user writes in English, reply in English; apply the same rule to other languages. If the user mixes languages, follow the primary language of the latest message."
            "For code-related questions, answer the user's main question first, then naturally mention the supporting code evidence or likely implementation locations when helpful."
            "Do not end every reply with next-step suggestions, follow-up offers, or action proposals by default. Only include them when the user explicitly asks for guidance, troubleshooting steps, implementation advice, or when a next action is truly necessary to answer correctly."
            "Avoid stiff section headings, excessive numbering, formulaic boilerplate, and repetitive closing phrases unless the user explicitly asks for that format."
            "Decide whether the latest user message actually needs a reply in context. Do not reply to pure acknowledgements, thanks, confirmations, or comments that add no actionable question or no meaningful new information."
            "When you decide no reply is needed, set should_auto_post to false, keep needs_human false unless a human is really needed, set skip_reason to a short explanation, and keep reply as an empty string or a minimal internal draft that will not be posted."
            "Return JSON with the fields: category, summary, reply, confidence, should_auto_post, needs_human, skip_reason."
        )
        user = json.dumps(
            {
                "issue": issue,
                "latest_comment": str((issue.get("latest_user_message") or {}).get("body") or issue.get("comment_body") or "").strip(),
                "latest_user_message": issue.get("latest_user_message") or {},
                "messages": issue.get("messages") or [],
                "related_context": related_context,
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
