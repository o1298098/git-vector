"""
索引完成后生成 MkDocs Material 静态 Wiki（站内全文搜索），输出到 DATA_DIR/wiki_sites/<project_id>/site/。
"""
from __future__ import annotations

import ast
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from itertools import groupby
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


def _safe_yaml_double_quoted_title(s: str) -> str:
    """MkDocs 首页 frontmatter title 双引号转义。"""
    return (s or "").replace("\\", "\\\\").replace('"', '\\"')


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


class _DirNode:
    """用于文件索引树：目录与文件分桶，避免同名文件/文件夹冲突。"""

    __slots__ = ("dirs", "files")

    def __init__(self) -> None:
        self.dirs: dict[str, _DirNode] = {}
        self.files: dict[str, tuple[str, int, bool]] = {}


def _file_tree_insert(
    root: _DirNode,
    path_norm: str,
    slug: str,
    sym_count: int,
    has_page: bool,
) -> None:
    parts = [p for p in _normalize_rel_path(path_norm).split("/") if p]
    if not parts:
        return
    *dir_parts, fname = parts
    node = root
    for d in dir_parts:
        if d not in node.dirs:
            node.dirs[d] = _DirNode()
        node = node.dirs[d]
    node.files[fname] = (slug, sym_count, has_page)


def _render_file_tree_md(node: _DirNode, indent: int = 0) -> list[str]:
    """嵌套无序列表，每级 4 空格缩进（与 Python-Markdown 嵌套列表兼容）。"""
    sp = "    " * indent
    lines: list[str] = []
    for dname in sorted(node.dirs.keys(), key=lambda x: x.lower()):
        lines.append(f"{sp}- **{dname}**")
        lines.extend(_render_file_tree_md(node.dirs[dname], indent + 1))
    for fname in sorted(node.files.keys(), key=lambda x: x.lower()):
        slug, cnt, has_page = node.files[fname]
        if has_page:
            lines.append(f"{sp}- [{fname}](files/{slug}.md) — {cnt} 个符号")
        else:
            lines.append(
                f"{sp}- `{fname}` — {cnt} 个符号（未生成单独页面，请用顶部搜索）"
            )
    return lines


def _symbol_anchor(kind: str, name: str) -> str:
    """与文件页标题锚点一致（不可写在 f-string 的 {{}} 内：正则含反斜杠会 SyntaxError）。"""
    return re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff_-]+", "-", f"{kind}-{name}")[:80]


# 功能说明正文过长时截断（避免单页过大）
MAX_FUNCTION_SUMMARY_CHARS = 6000


def _trim_summary(text: str) -> str:
    t = (text or "").strip()
    if len(t) > MAX_FUNCTION_SUMMARY_CHARS:
        return t[: MAX_FUNCTION_SUMMARY_CHARS].rstrip() + "\n\n…（已截断）"
    return t


def _md_list_item_body(text: str) -> list[str]:
    """把多行说明写成列表项下的缩进块，避免破坏 Markdown 列表结构。"""
    lines_out: list[str] = []
    for ln in (text or "").splitlines():
        lines_out.append(f"    {ln}")
    return lines_out


def _python_docstring_ast(code: str) -> str:
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return ""
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            ds = (ast.get_docstring(node) or "").strip()
            if ds:
                return ds
    return (ast.get_docstring(tree) or "").strip()


def _python_docstring_regex(code: str) -> str:
    """AST 失败时（片段不完整）匹配 `:` 后第一个三引号 docstring。"""
    m = re.search(r":\s*\n\s*'''([\s\S]*?)'''", code)
    if m:
        return m.group(1).strip()
    m = re.search(r':\s*\n\s*"""([\s\S]*?)"""', code)
    if m:
        return m.group(1).strip()
    return ""


def _js_ts_docstring(code: str) -> str:
    s = code.lstrip()
    if not s.startswith("/**"):
        return ""
    end = s.find("*/")
    if end == -1:
        return ""
    inner = s[3:end]
    lines: list[str] = []
    for line in inner.splitlines():
        ln = line.strip().lstrip("*").strip()
        if ln:
            lines.append(ln)
    return "\n".join(lines).strip()


def _go_rust_line_comments(code: str) -> str:
    lines_out: list[str] = []
    for line in code.splitlines():
        st = line.strip()
        if st.startswith("///"):
            lines_out.append(st[3:].strip())
        elif st.startswith("//"):
            lines_out.append(st[2:].strip())
        elif st.startswith("func ") or re.match(r"^(pub(\([^)]*\))?\s+)?(async\s+)?fn\s", st):
            break
    return " ".join(lines_out).strip() if lines_out else ""


def _c_style_block_docstring(code: str) -> str:
    s = code.lstrip()
    if not s.startswith("/**"):
        return ""
    end = s.find("*/")
    if end == -1:
        return ""
    inner = s[3:end]
    lines = [ln.strip().lstrip("*").strip() for ln in inner.splitlines() if ln.strip().lstrip("*").strip()]
    return "\n".join(lines).strip()


def _docstring_from_code(code: str, path: str) -> str:
    """从 chunk 的源码片段提取文档注释（不依赖 LLM）。"""
    if not (code or "").strip():
        return ""
    ext = _ext_of(_normalize_rel_path(path))
    if ext == "py":
        doc = _python_docstring_ast(code)
        if doc:
            return doc
        return _python_docstring_regex(code)
    if ext in ("js", "jsx", "ts", "tsx", "vue", "java", "cs", "c", "h", "cpp", "hpp"):
        doc = _js_ts_docstring(code) if ext in ("js", "jsx", "ts", "tsx", "vue") else _c_style_block_docstring(code)
        if doc:
            return doc
    if ext == "go":
        return _go_rust_line_comments(code)
    if ext == "rs":
        return _go_rust_line_comments(code)
    if ext in ("rb", "php"):
        # =begin / =end 或 # 多行 — 简化为连续以 # 开头的行
        lines_out: list[str] = []
        for line in code.splitlines():
            st = line.strip()
            if st.startswith("#") and not st.startswith("#!"):
                lines_out.append(st.lstrip("#").strip())
            elif st and not st.startswith("#") and lines_out:
                break
        return "\n".join(lines_out).strip() if lines_out else ""
    return ""


def _normalize_ws(s: str) -> str:
    return " ".join((s or "").split())


def _yaml_double_quoted(s: str) -> str:
    """YAML 双引号 title 内转义。"""
    return (s or "").replace("\\", "\\\\").replace('"', '\\"')


def _wiki_llm_function_description(chunk: dict[str, Any]) -> str:
    """
    Wiki「功能说明」**仅**使用索引阶段 `describe_functions_batch` 写入的 LLM 描述，
    与向量库检索用的自然语言一致；不用源码 docstring 冒充功能说明。
    """
    llm = (chunk.get("description") or "").strip()
    if llm:
        return _trim_summary(llm)
    kind = str(chunk.get("kind", ""))
    if kind == "file":
        return (
            "（无 LLM 描述：当前为文件级索引，未对单个函数生成说明；"
            "可配置 LLM 并尽量使用函数级解析后重新索引，或查看下方代码摘录。）"
        )
    return (
        "（无 LLM 描述：请在环境中配置 Dify / Azure OpenAI / OpenAI 后重新索引本仓库；"
        "若已配置仍为空，请查看索引日志中 describe 阶段是否报错。）"
    )


def _wiki_source_docstring_supplement(chunk: dict[str, Any]) -> str | None:
    """
    源码中的文档字符串/注释，单独展示，避免与「功能说明」混淆。
    若与 LLM 描述实质相同（去空白后一致）则不重复列出。
    """
    llm = (chunk.get("description") or "").strip()
    code = (chunk.get("code") or "").strip()
    path = str(chunk.get("path", ""))
    doc = _docstring_from_code(code, path)
    if not doc.strip():
        return None
    doc_t = _trim_summary(doc)
    if llm and _normalize_ws(doc_t) == _normalize_ws(_trim_summary(llm)):
        return None
    return doc_t


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
    project_name: str = "",
) -> str:
    pname = (project_name or "").strip()
    if pname:
        project_header = f"## 项目信息\n\n- **项目名称**: {pname}\n- **project_id**: `{project_id}`\n\n"
    else:
        project_header = f"## 项目信息\n\n- **project_id**: `{project_id}`\n\n"

    samples: list[str] = []
    for c in chunks[:ARCH_SAMPLE_CHUNKS]:
        p = _normalize_rel_path(str(c.get("path", "")))
        n = str(c.get("name", ""))
        k = str(c.get("kind", "function"))
        summary = _wiki_llm_function_description(c)
        line = f"- `{p}` :: `{n}` ({k}) — {summary}"
        samples.append(line)

    client = get_llm_client()
    if not client:
        return (
            "# 架构与功能总览\n\n"
            + project_header
            + "未配置 LLM，无法自动生成架构说明。以下为目录树节选与代码单元列表，请使用左侧搜索或「符号索引」浏览。\n\n"
            "## 目录树（节选）\n\n```text\n"
            f"{tree_text}\n```\n\n"
            "## 代码单元摘要（节选）\n\n"
            + "\n".join(samples)
            + "\n"
        )

    if pname:
        pname_line = f"项目展示名称：`{pname}`\n项目标识 project_id：`{project_id}`\n\n"
    else:
        pname_line = f"项目标识 project_id：`{project_id}`\n\n"
    user = (
        "你是资深软件架构师。根据下面「目录树节选」与「代码单元摘要」，用**中文 Markdown** 写一份「架构与功能总览」。\n\n"
        "必须包含三级标题：## 模块与职责、## 主要数据与控制流、## 与外部系统的交互（若无则写「未从材料中观察到」）。\n"
        "要求：只根据材料推断，不要编造材料中不存在的功能或依赖；可适度使用列表与加粗。\n\n"
        + pname_line
        + "## 目录树（节选）\n```text\n"
        + f"{tree_text}\n```\n\n"
        + "## 代码单元摘要（节选）\n"
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
        + project_header
        + "## 目录树（节选）\n\n```text\n"
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
            llm_desc = _wiki_llm_function_description(c)
            calls = c.get("calls") or []
            anchor = _symbol_anchor(kind, name)
            lines.append(f"### `{name}` — `{kind}` {{#{anchor}}}")
            lines.append("")
            lines.append("- **功能说明**（LLM 生成）:")
            lines.extend(_md_list_item_body(llm_desc))
            src_doc = _wiki_source_docstring_supplement(c)
            if src_doc:
                lines.append("")
                lines.append("- **源码文档**（docstring / 注释）:")
                lines.extend(_md_list_item_body(src_doc))
            lines.append("")
            lines.append(f"- **位置**: 第 {sl}–{el} 行" if el else f"- **位置**: 第 {sl} 行起")
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
    paths_with_file_page: set[str],
) -> list[str]:
    """按文件分组输出符号表（避免每行重复长路径导致表格过窄难读）；返回 nav 用的文件名列表。"""
    nav_names: list[str] = []
    sorted_chunks = sorted(
        chunks,
        key=lambda x: (_normalize_rel_path(str(x.get("path", ""))), str(x.get("name", ""))),
    )
    parts: list[list[dict[str, Any]]] = []
    cur: list[dict[str, Any]] = []
    for c in sorted_chunks:
        cur.append(c)
        if len(cur) >= rows_per_file:
            parts.append(cur)
            cur = []
    if cur:
        parts.append(cur)

    for pi, group in enumerate(parts):
        md_filename = "symbol-index.md" if pi == 0 else f"symbol-index-{pi + 1}.md"
        nav_names.append(md_filename)
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
            "按 **文件** 分组列出符号；长路径只在每组标题出现一次，表格更易阅读。",
            "",
        ]
        for path_norm, file_chunks_iter in groupby(
            group,
            key=lambda x: _normalize_rel_path(str(x.get("path", ""))),
        ):
            file_chunks = list(file_chunks_iter)
            slug = slug_map.get(path_norm, _file_slug(path_norm))
            path_esc = _escape_md_table_cell(path_norm)
            lines.append(f"## `{path_esc}`")
            lines.append("")
            if path_norm in paths_with_file_page:
                lines.append(f"[打开该文件说明页](files/{slug}.md)")
                lines.append("")
            lines.append("| 符号 | 类型 | 行号 | 功能说明 |")
            lines.append("| --- | --- | --- | --- |")
            for c in file_chunks:
                sym_name = str(c.get("name", ""))
                kind = str(c.get("kind", ""))
                sl = c.get("start_line", "")
                el = c.get("end_line", "")
                row_line = f"{sl}-{el}" if el else str(sl)
                desc = _escape_md_table_cell(_wiki_llm_function_description(c))
                anchor = _symbol_anchor(kind, sym_name)
                sym_cell = f"[`{_escape_md_table_cell(sym_name)}`](files/{slug}.md#{anchor})"
                if path_norm not in paths_with_file_page:
                    sym_cell = f"`{_escape_md_table_cell(sym_name)}`"
                lines.append(f"| {sym_cell} | `{kind}` | {row_line} | {desc} |")
            lines.append("")
        (docs_dir / md_filename).write_text("\n".join(lines), encoding="utf-8")
    return nav_names


def generate_project_wiki(
    project_id: str,
    repo_path: Path,
    chunks: list[dict[str, Any]],
    collected_files: list[tuple[str, str]] | None = None,
    project_name: str = "",
) -> dict[str, Any]:
    """
    生成 MkDocs 源文件并执行 build。失败时抛出异常（由 indexer 捕获）。
    project_name：可选展示名（如中文项目名），由触发接口或 Webhook 传入。
    """
    if not settings.wiki_enabled:
        return {"skipped": True, "reason": "wiki_disabled"}

    pname = (project_name or "").strip()
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

    page_title = _safe_yaml_double_quoted_title(
        f"{pname}（{project_id}）" if pname else f"项目 Wiki — {project_id}"
    )
    site_title = f"{pname} · {project_id}" if pname else f"Wiki — {project_id}"
    h1_line = pname if pname else project_id

    # 首页
    index_lines = [
        "---",
        f'title: "{page_title}"',
        "description: 代码索引与符号说明（自动生成）",
        "tags: [index]",
        "---",
        "",
        f"# {h1_line}",
        "",
        "## 元数据",
        "",
    ]
    if pname:
        index_lines.extend(
            [
                f"- **项目名称**: {pname}",
                f"- **project_id**: `{project_id}`",
            ]
        )
    else:
        index_lines.append(f"- **project_id**: `{project_id}`")
    index_lines.extend(
        [
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
    )
    for ext, cnt in sorted(ext_counts.items(), key=lambda x: -x[1])[:40]:
        index_lines.append(f"| `{ext}` | {cnt} |")
    index_lines.extend(
        [
            "",
            "## 使用说明",
            "",
            "使用顶部 **搜索框** 可全文检索路径、函数名与说明。",
            "",
            "**功能说明** 一栏仅展示索引阶段由 LLM（Dify / OpenAI / Azure OpenAI）生成的描述，与向量语义检索一致；"
            "若未配置 LLM 或生成失败，会显示提示文案。源码中的 docstring 如有且与 LLM 描述不同，会单独出现在 **源码文档** 中。",
            "",
        ]
    )
    if readme:
        index_lines.extend(["## README 摘录", "", readme, ""])
    (docs_dir / "index.md").write_text("\n".join(index_lines), encoding="utf-8")

    arch = _architecture_markdown(project_id, repo_path, chunks, tree_text, project_name=pname)
    (docs_dir / "architecture.md").write_text(arch, encoding="utf-8")

    sorted_file_items = sorted(by_file.items(), key=lambda x: x[0])
    paths_with_file_page = {p for p, _ in sorted_file_items[:max_file_pages]}

    # 文件索引：树状目录 + 可折叠的扁平表
    tree_root = _DirNode()
    for path_norm, syms in sorted_file_items:
        slug = slug_map[path_norm]
        has_page = path_norm in paths_with_file_page
        _file_tree_insert(tree_root, path_norm, slug, len(syms), has_page)
    tree_lines = _render_file_tree_md(tree_root)
    overflow_files = len(by_file) - min(len(by_file), max_file_pages)
    fi_lines = [
        "---",
        'title: "文件索引"',
        "description: 按路径浏览生成的文件说明页",
        "tags: [files, index]",
        "---",
        "",
        "# 文件索引",
        "",
        "按仓库 **目录树** 浏览；点击文件名进入该文件的符号说明页。也可使用顶部 **搜索** 按路径或符号名查找。",
        "",
        *tree_lines,
        "",
    ]
    if overflow_files > 0:
        fi_lines.append(
            f"超出单仓页面上限（`WIKI_MAX_FILE_PAGES={max_file_pages}`）的文件仍出现在上表中，"
            f"但**未生成单独文档页**（共 {overflow_files} 个）；请用搜索或「符号索引」查看。"
        )
        fi_lines.append("")
    fi_lines.extend(
        [
            "??? note \"扁平路径列表（备选，便于复制完整路径）\"",
            "    | 路径 | 符号数 | 文档 |",
            "    | --- | ---: | --- |",
        ]
    )
    for i, (path_norm, syms) in enumerate(sorted_file_items):
        if i >= max_file_pages:
            fi_lines.append(
                f"    | … | … | *另有 {overflow_files} 个文件未单独建页* |"
            )
            break
        slug = slug_map[path_norm]
        fi_lines.append(
            f"    | `{_escape_md_table_cell(path_norm)}` | {len(syms)} | [打开](files/{slug}.md) |"
        )
    fi_lines.append("")
    (docs_dir / "file-index.md").write_text("\n".join(fi_lines), encoding="utf-8")

    _write_file_pages(docs_dir, by_file, slug_map, max_file_pages)
    symbol_nav = _write_symbol_index_parts(
        docs_dir, chunks, slug_map, rows_per, paths_with_file_page
    )

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
        "site_name": site_title,
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
        "project_name": pname or None,
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
