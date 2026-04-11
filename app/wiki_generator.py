"""
索引完成后生成 MkDocs Material 静态 Wiki（站内全文搜索），输出到 DATA_DIR/wiki_sites/<project_id>/site/。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from app.config import settings
from app.llm_client import get_llm_client

logger = logging.getLogger(__name__)

# 单文件页面上限（超大仓降级为仅索引 + 符号总表）
DEFAULT_MAX_FILE_PAGES = 5000
# 符号总表每个 Markdown 文件最多行数（表格行）
DEFAULT_SYMBOL_ROWS_PER_FILE = 4000
# 架构页摘要最多条
ARCH_SAMPLE_CHUNKS = 60
# 目录树最大行数
TREE_MAX_LINES = 120
# 单符号页内代码块最大字符
MAX_CODE_IN_WIKI = 4000


def _safe_project_id(project_id: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in project_id)


def _normalize_rel_path(p: str) -> str:
    return str(p).replace("\\", "/")


def _git_head(repo_path: Path) -> str:
    try:
        r = subprocess.run(
            ["git", "-C", str(repo_path), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception as e:
        logger.debug("git rev-parse failed: %s", e)
    return "unknown"


def _file_slug(rel_path: str) -> str:
    h = hashlib.sha256(rel_path.encode("utf-8")).hexdigest()[:16]
    return h


def _ext_of(path: str) -> str:
    if "." in path:
        return path.rsplit(".", 1)[-1].lower()
    return ""


def _escape_md_table_cell(s: str) -> str:
    return (s or "").replace("|", "\\|").replace("\n", " ").strip()[:500]


def _build_directory_tree(repo_path: Path, max_lines: int = TREE_MAX_LINES) -> str:
    lines: list[str] = []
    try:
        for root, dirs, files in os.walk(repo_path):
            dirs[:] = sorted([d for d in dirs if not d.startswith(".") and d not in ("node_modules", "venv", ".venv", "__pycache__", "vendor", "dist", "build")])
            rel_root = Path(root).relative_to(repo_path)
            for d in dirs:
                p = rel_root / d if rel_root != Path(".") else Path(d)
                lines.append(str(p).replace("\\", "/") + "/")
            if rel_root != Path("."):
                continue
            for f in sorted(files)[:50]:
                if f.startswith("."):
                    continue
                lines.append(f)
            break
        # 再扫一层常见源码目录
        for sub in ("app", "src", "lib", "pkg", "internal", "cmd"):
            p = repo_path / sub
            if p.is_dir():
                lines.append(f"{sub}/ …")
    except Exception as e:
        logger.debug("tree walk: %s", e)
    return "\n".join(lines[:max_lines])


def _readme_excerpt(files: list[tuple[str, str]], limit: int = 6000) -> str:
    for path, content in files:
        if path.replace("\\", "/").lower().endswith("readme.md"):
            text = content[:limit]
            if len(content) > limit:
                text += "\n\n…（已截断）"
            return text
    return ""


def _architecture_markdown(
    project_id: str,
    repo_path: Path,
    chunks: list[dict[str, Any]],
    tree_text: str,
) -> str:
    samples: list[str] = []
    for c in chunks[:ARCH_SAMPLE_CHUNKS]:
        p = _normalize_rel_path(str(c.get("path", "")))
        n = str(c.get("name", ""))
        d = (c.get("description") or "").strip()
        k = str(c.get("kind", "function"))
        line = f"- `{p}` :: `{n}` ({k})"
        if d:
            line += f" — {d}"
        samples.append(line)

    client = get_llm_client()
    if not client:
        return (
            "# 架构与功能总览\n\n"
            "未配置 LLM，无法自动生成架构说明。以下为目录树节选与代码单元列表，请使用左侧搜索或「符号索引」浏览。\n\n"
            "## 目录树（节选）\n\n```text\n"
            f"{tree_text}\n```\n\n"
            "## 代码单元摘要（节选）\n\n"
            + "\n".join(samples)
            + "\n"
        )

    user = (
        "你是资深软件架构师。根据下面「目录树节选」与「代码单元摘要」，用**中文 Markdown** 写一份「架构与功能总览」。\n\n"
        "必须包含三级标题：## 模块与职责、## 主要数据与控制流、## 与外部系统的交互（若无则写「未从材料中观察到」）。\n"
        "要求：只根据材料推断，不要编造材料中不存在的功能或依赖；可适度使用列表与加粗。\n\n"
        f"项目标识：`{project_id}`\n\n"
        "## 目录树（节选）\n```text\n"
        f"{tree_text}\n```\n\n"
        "## 代码单元摘要（节选）\n"
        + "\n".join(samples)
        + "\n\n请直接输出 Markdown 正文（从一级标题 `# 架构与功能总览` 开始）。"
    )
    try:
        body = client.chat(
            system="只输出 Markdown 正文，不要前言或后语。",
            user=user,
        ).strip()
        if body:
            return body
    except Exception as e:
        logger.warning("Architecture LLM failed: %s", e)
    return (
        "# 架构与功能总览\n\n"
        "（自动生成失败，以下为节选材料。）\n\n"
        "## 目录树（节选）\n\n```text\n"
        f"{tree_text}\n```\n\n"
        "## 代码单元摘要（节选）\n\n"
        + "\n".join(samples)
        + "\n"
    )


def _write_file_pages(
    docs_dir: Path,
    by_file: dict[str, list[dict[str, Any]]],
    slug_map: dict[str, str],
    max_pages: int,
) -> None:
    files_dir = docs_dir / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    items = sorted(by_file.items(), key=lambda x: x[0])
    for i, (rel_path, syms) in enumerate(items):
        if i >= max_pages:
            break
        slug = slug_map[rel_path]
        path_norm = _normalize_rel_path(rel_path)
        ext = _ext_of(path_norm)
        lines: list[str] = [
            "---",
            f'title: "{path_norm}"',
            f'description: "文件 {path_norm} 内的符号与说明"',
            f"tags:",
            f"  - file",
            f"  - ext-{ext or 'none'}",
            "---",
            "",
            f"# `{path_norm}`",
            "",
            f"- **语言/扩展名**: `{ext or 'n/a'}`",
            f"- **符号数量**: {len(syms)}",
            "",
            "## 符号列表",
            "",
        ]
        for c in sorted(syms, key=lambda x: (int(x.get("start_line") or 0), str(x.get("name", "")))):
            name = str(c.get("name", ""))
            kind = str(c.get("kind", "function"))
            sl = c.get("start_line")
            el = c.get("end_line")
            desc = (c.get("description") or "").strip()
            calls = c.get("calls") or []
            anchor = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff_-]+", "-", f"{kind}-{name}")[:80]
            lines.append(f"### `{name}` — `{kind}` {{#{anchor}}}")
            lines.append("")
            lines.append(f"- **位置**: 第 {sl}–{el} 行" if el else f"- **位置**: 第 {sl} 行起")
            if desc:
                lines.append(f"- **说明**: {desc}")
            if calls:
                lines.append(f"- **调用**: {', '.join(str(x) for x in calls[:40])}")
            code = (c.get("code") or "").strip()
            if code:
                snippet = code[:MAX_CODE_IN_WIKI]
                if len(code) > MAX_CODE_IN_WIKI:
                    snippet += "\n\n/* … 已截断 … */"
                lines.extend(["", "??? note \"代码摘录\"", "", "```text", snippet, "```", ""])
            lines.append("")
        (files_dir / f"{slug}.md").write_text("\n".join(lines), encoding="utf-8")


def _write_symbol_index_parts(
    docs_dir: Path,
    chunks: list[dict[str, Any]],
    slug_map: dict[str, str],
    rows_per_file: int,
) -> list[str]:
    """返回 nav 用的 symbol 索引文件名列表。"""
    nav_names: list[str] = []
    parts: list[list[dict[str, Any]]] = []
    cur: list[dict[str, Any]] = []
    for c in sorted(
        chunks,
        key=lambda x: (_normalize_rel_path(str(x.get("path", ""))), str(x.get("name", ""))),
    ):
        cur.append(c)
        if len(cur) >= rows_per_file:
            parts.append(cur)
            cur = []
    if cur:
        parts.append(cur)

    for pi, group in enumerate(parts):
        name = "symbol-index.md" if pi == 0 else f"symbol-index-{pi + 1}.md"
        nav_names.append(name)
        title = "符号索引" if pi == 0 else f"符号索引（第 {pi + 1} 部分）"
        lines: list[str] = [
            "---",
            f'title: "{title}"',
            "description: 全量符号与所在文件",
            "tags: [symbols, index]",
            "---",
            "",
            "# 符号索引",
            "",
            "| 符号 | 类型 | 文件 | 行号 | 说明 |",
            "| --- | --- | --- | --- | --- |",
        ]
        for c in group:
            path_norm = _normalize_rel_path(str(c.get("path", "")))
            slug = slug_map.get(path_norm, _file_slug(path_norm))
            name = str(c.get("name", ""))
            kind = str(c.get("kind", ""))
            sl = c.get("start_line", "")
            el = c.get("end_line", "")
            row_line = f"{sl}-{el}" if el else str(sl)
            desc = _escape_md_table_cell(str(c.get("description", "")))
            link = f"[{ _escape_md_table_cell(path_norm) }](files/{slug}.md#{re.sub(r'[^a-zA-Z0-9\u4e00-\u9fff_-]+', '-', f'{kind}-{name}')[:80]})"
            lines.append(
                f"| `{_escape_md_table_cell(name)}` | `{kind}` | {link} | {row_line} | {desc} |"
            )
        (docs_dir / name).write_text("\n".join(lines), encoding="utf-8")
    return nav_names


def generate_project_wiki(
    project_id: str,
    repo_path: Path,
    chunks: list[dict[str, Any]],
    collected_files: list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    """
    生成 MkDocs 源文件并执行 build。失败时抛出异常（由 indexer 捕获）。
    """
    if not settings.wiki_enabled:
        return {"skipped": True, "reason": "wiki_disabled"}

    safe = _safe_project_id(project_id)
    wiki_root = settings.data_path / "wiki_sites" / safe
    work_dir = settings.data_path / "wiki_work" / safe
    site_out = wiki_root / "site"

    max_file_pages = int(os.environ.get("WIKI_MAX_FILE_PAGES") or getattr(settings, "wiki_max_file_pages", DEFAULT_MAX_FILE_PAGES))
    rows_per = int(os.environ.get("WIKI_SYMBOL_ROWS_PER_FILE") or getattr(settings, "wiki_symbol_rows_per_file", DEFAULT_SYMBOL_ROWS_PER_FILE))

    if work_dir.exists():
        shutil.rmtree(work_dir, ignore_errors=True)
    docs_dir = work_dir / "docs"
    docs_dir.mkdir(parents=True, exist_ok=True)

    commit = _git_head(repo_path)
    generated_at = datetime.now(timezone.utc).isoformat()
    tree_text = _build_directory_tree(repo_path)

    by_file: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for c in chunks:
        p = _normalize_rel_path(str(c.get("path", "")))
        if p:
            by_file[p].append(c)

    slug_map: dict[str, str] = {p: _file_slug(p) for p in by_file}

    # 统计扩展名
    ext_counts: dict[str, int] = defaultdict(int)
    for p in by_file:
        ext_counts[_ext_of(p) or "none"] += 1

    readme = _readme_excerpt(collected_files or [], limit=8000)

    # 首页
    index_lines = [
        "---",
        f'title: "项目 Wiki — {project_id}"',
        "description: 代码索引与符号说明（自动生成）",
        "tags: [index]",
        "---",
        "",
        f"# {project_id}",
        "",
        "## 元数据",
        "",
        f"- **project_id**: `{project_id}`",
        f"- **Git 提交**: `{commit}`",
        f"- **生成时间（UTC）**: {generated_at}",
        f"- **符号/单元总数**: {len(chunks)}",
        f"- **文件数（有符号）**: {len(by_file)}",
        "",
        "## 语言 / 扩展名分布",
        "",
        "| 扩展名 | 文件数 |",
        "| --- | --- |",
    ]
    for ext, cnt in sorted(ext_counts.items(), key=lambda x: -x[1])[:40]:
        index_lines.append(f"| `{ext}` | {cnt} |")
    index_lines.extend(["", "## 使用说明", "", "使用顶部 **搜索框** 可全文检索路径、函数名与中文说明。", ""])
    if readme:
        index_lines.extend(["## README 摘录", "", readme, ""])
    (docs_dir / "index.md").write_text("\n".join(index_lines), encoding="utf-8")

    arch = _architecture_markdown(project_id, repo_path, chunks, tree_text)
    (docs_dir / "architecture.md").write_text(arch, encoding="utf-8")

    # 文件索引（表格 + 链接）
    fi_lines = [
        "---",
        'title: "文件索引"',
        "description: 按路径浏览生成的文件说明页",
        "tags: [files, index]",
        "---",
        "",
        "# 文件索引",
        "",
        "| 路径 | 符号数 | 文档 |",
        "| --- | ---: | --- |",
    ]
    for i, (path_norm, syms) in enumerate(sorted(by_file.items(), key=lambda x: x[0])):
        if i >= max_file_pages:
            fi_lines.append(f"| … | … | *另有 {len(by_file) - max_file_pages} 个文件未单独建页* |")
            break
        slug = slug_map[path_norm]
        fi_lines.append(
            f"| `{_escape_md_table_cell(path_norm)}` | {len(syms)} | [打开](files/{slug}.md) |"
        )
    (docs_dir / "file-index.md").write_text("\n".join(fi_lines), encoding="utf-8")

    _write_file_pages(docs_dir, by_file, slug_map, max_file_pages)
    symbol_nav = _write_symbol_index_parts(docs_dir, chunks, slug_map, rows_per)

    # mkdocs.yml
    nav: list[Any] = [
        {"首页": "index.md"},
        {"架构总览": "architecture.md"},
        {"文件索引": "file-index.md"},
    ]
    if len(symbol_nav) == 1:
        nav.append({"符号索引": symbol_nav[0]})
    else:
        nested = [{f"第 {i + 1} 部分": n} for i, n in enumerate(symbol_nav)]
        nav.append({f"符号索引（共 {len(symbol_nav)} 部分）": nested})

    mkdocs_path = work_dir / "mkdocs.yml"
    site_out.parent.mkdir(parents=True, exist_ok=True)

    mkdocs_content: dict[str, Any] = {
        "site_name": f"Wiki — {project_id}",
        "docs_dir": "docs",
        "site_dir": str(site_out.resolve()),
        "theme": {
            "name": "material",
            "language": "zh",
            "features": [
                "navigation.indexes",
                "navigation.expand",
                "search.suggest",
                "search.highlight",
                "content.code.copy",
            ],
        },
        "markdown_extensions": [
            "attr_list",
            "admonition",
            "pymdownx.details",
            "pymdownx.superfences",
        ],
        # Lunr：中英混排仍以英文分词为主，兼容性最好；正文中文仍可被检索到
        "plugins": [
            {"search": {"lang": ["en"]}},
        ],
        "nav": nav,
    }

    mkdocs_path.write_text(yaml.safe_dump(mkdocs_content, allow_unicode=True, sort_keys=False), encoding="utf-8")

    logger.info("Running mkdocs build for project=%s work_dir=%s site_out=%s", project_id, work_dir, site_out)
    proc = subprocess.run(
        [sys.executable, "-m", "mkdocs", "build", "-f", str(mkdocs_path), "-q"],
        cwd=str(work_dir),
        capture_output=True,
        text=True,
        timeout=3600,
    )
    if proc.returncode != 0:
        err = (proc.stderr or "") + (proc.stdout or "")
        logger.error("mkdocs build failed: %s", err[-4000:])
        raise RuntimeError(f"mkdocs build failed: {err[-2000:]}")

    manifest = {
        "project_id": project_id,
        "safe_id": safe,
        "commit": commit,
        "generated_at": generated_at,
        "chunk_count": len(chunks),
        "file_count_with_symbols": len(by_file),
        "site_dir": str(site_out.resolve()),
        "browse_url_path": f"/wiki/{safe}/site/",
    }
    wiki_root.mkdir(parents=True, exist_ok=True)
    (wiki_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    if os.environ.get("WIKI_KEEP_WORK", "").strip().lower() not in ("1", "true", "yes"):
        shutil.rmtree(work_dir, ignore_errors=True)

    logger.info("Wiki built for %s -> %s", project_id, site_out)
    return manifest


def wiki_manifest(project_id: str) -> dict[str, Any] | None:
    safe = _safe_project_id(project_id)
    p = settings.data_path / "wiki_sites" / safe / "manifest.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
