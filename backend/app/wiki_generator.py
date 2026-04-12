"""
索引完成后生成静态 Wiki，输出到 DATA_DIR/wiki_sites/<project_id>/site/。

后端由 WIKI_BACKEND 选择：mkdocs（Material，纯 Python）/ starlight / vitepress（需 Node.js）。
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
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import groupby
from pathlib import Path
from typing import Any

import yaml

from app.config import settings
from app.content_locale import WikiI18n, wiki_i18n
from app.effective_settings import (
    effective_content_language,
    effective_wiki_backend,
    effective_wiki_enabled,
    effective_wiki_max_file_pages,
    effective_wiki_symbol_rows_per_file,
)
from app.wiki_node_build import build_starlight_site, build_vitepress_site
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


@dataclass(frozen=True)
class WikiDocContext:
    """写入各后端共用的 Markdown 时所需的上下文。"""

    project_id: str
    repo_path: Path
    project_name: str
    commit: str
    generated_at: str
    chunks: list[dict[str, Any]]
    by_file: dict[str, list[dict[str, Any]]]
    slug_map: dict[str, str]
    ext_counts: dict[str, int]
    readme: str
    tree_text: str
    page_title: str
    site_title: str
    h1_line: str
    max_file_pages: int
    rows_per: int
    i18n: WikiI18n


def _safe_project_id(project_id: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in project_id)


def _safe_yaml_double_quoted_title(s: str) -> str:
    """MkDocs 首页 frontmatter title 双引号转义。"""
    return (s or "").replace("\\", "\\\\").replace('"', '\\"')


def _normalize_rel_path(p: str) -> str:
    return str(p).replace("\\", "/")


def _wiki_link_to_file_page(
    slug: str,
    *,
    mkdocs_style: bool,
    anchor: str = "",
    node_deploy_prefix: str | None = None,
) -> str:
    """
    MkDocs：与源文件同在 docs/ 根下时用相对路径 files/<slug>.md。

    Starlight/VitePress：构建结果为 files/<slug>/index.html。
    - 相对链 `files/...` 在 file-index 下会错成 .../file-index/files/...
    - 以 `/files/...` 开头会被浏览器当成「站点根」，在挂载于 /wiki/.../site/ 时变成 http://host/files/...（错）

    因此非 MkDocs 时使用 **完整挂载前缀**（与 manifest browse_url_path 一致，如 /wiki/<id>/site/）拼接：
    `{prefix}files/<slug>/`
    """
    frag = f"#{anchor}" if anchor else ""
    if mkdocs_style:
        return f"files/{slug}.md{frag}"
    if not (node_deploy_prefix or "").strip():
        raise ValueError("Starlight/VitePress 文件链需要 node_deploy_prefix（与 Wiki 挂载路径一致）")
    base = node_deploy_prefix.strip()
    if not base.endswith("/"):
        base += "/"
    return f"{base}files/{slug}/{frag}"


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


def _render_file_tree_md(
    node: _DirNode,
    ws: WikiI18n,
    indent: int = 0,
    *,
    mkdocs_style_links: bool,
    node_deploy_prefix: str | None,
) -> list[str]:
    """嵌套无序列表，每级 4 空格缩进（与 Python-Markdown 嵌套列表兼容）。"""
    sp = "    " * indent
    lines: list[str] = []
    for dname in sorted(node.dirs.keys(), key=lambda x: x.lower()):
        lines.append(f"{sp}- **{dname}**")
        lines.extend(
            _render_file_tree_md(
                node.dirs[dname],
                ws,
                indent + 1,
                mkdocs_style_links=mkdocs_style_links,
                node_deploy_prefix=node_deploy_prefix,
            )
        )
    for fname in sorted(node.files.keys(), key=lambda x: x.lower()):
        slug, cnt, has_page = node.files[fname]
        if has_page:
            href = _wiki_link_to_file_page(
                slug,
                mkdocs_style=mkdocs_style_links,
                node_deploy_prefix=node_deploy_prefix,
            )
            lines.append(
                sp
                + ws.ft_symbols_line.format(fname=fname, href=href, cnt=cnt)
            )
        else:
            lines.append(sp + ws.ft_symbols_plain.format(fname=fname, cnt=cnt))
    return lines


def _symbol_anchor(kind: str, name: str) -> str:
    """与文件页标题锚点一致（不可写在 f-string 的 {{}} 内：正则含反斜杠会 SyntaxError）。"""
    return re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff_-]+", "-", f"{kind}-{name}")[:80]


def _html_escape(text: str) -> str:
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _file_symbol_heading(name: str, kind: str, anchor: str) -> str:
    """
    带稳定 id 的符号标题。Starlight 内容按 MDX 处理，`### ... {#id}` 中的 `{` 会触发 MDX 表达式导致构建失败；
    故统一用 HTML 标题（MkDocs / VitePress 同样可用）。
    """
    return (
        f'<h3 id="{_html_escape(anchor)}">'
        f"<code>{_html_escape(name)}</code> — <code>{_html_escape(kind)}</code>"
        f"</h3>"
    )


# 功能说明正文过长时截断（避免单页过大）
MAX_FUNCTION_SUMMARY_CHARS = 6000


def _trim_summary(text: str, ws: WikiI18n) -> str:
    t = (text or "").strip()
    if len(t) > MAX_FUNCTION_SUMMARY_CHARS:
        return t[: MAX_FUNCTION_SUMMARY_CHARS].rstrip() + ws.trim_truncated
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


def _wiki_llm_function_description(chunk: dict[str, Any], ws: WikiI18n) -> str:
    """
    Wiki「功能说明」**仅**使用索引阶段 `describe_functions_batch` 写入的 LLM 描述，
    与向量库检索用的自然语言一致；不用源码 docstring 冒充功能说明。
    """
    llm = (chunk.get("description") or "").strip()
    if llm:
        return _trim_summary(llm, ws)
    kind = str(chunk.get("kind", ""))
    if kind == "file":
        return ws.wiki_desc_none_file
    return ws.wiki_desc_none_fn


def _wiki_source_docstring_supplement(chunk: dict[str, Any], ws: WikiI18n) -> str | None:
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
    doc_t = _trim_summary(doc, ws)
    if llm and _normalize_ws(doc_t) == _normalize_ws(_trim_summary(llm, ws)):
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


_README_MD_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_README_HTML_IMG = re.compile(r"<img\b[^>]*>", re.IGNORECASE)


def _sanitize_readme_for_wiki_markdown(text: str) -> str:
    """避免 README 中的图片被 Starlight/Astro 当作内容目录下的静态资源解析（仓库相对路径在 Wiki 工作区不存在）。"""

    def repl_md(m: re.Match[str]) -> str:
        alt = m.group(1).strip()
        inner = (m.group(2) or "").strip()
        url = inner.split()[0].strip("<>") if inner else ""
        if not url:
            return m.group(0)
        lu = url.lower()
        if lu.startswith(("http://", "https://", "//")):
            label = alt or "图片"
            return f"[{label}]({url})"
        note = f"README 内图片（未复制到 Wiki）：`{url}`"
        if alt:
            note += f"，说明：{alt}"
        return f"（{note}）"

    text = _README_MD_IMAGE.sub(repl_md, text)

    def repl_html(m: re.Match[str]) -> str:
        tag = m.group(0)
        src_m = re.search(r"src\s*=\s*[\"']([^\"']+)[\"']", tag, re.I)
        src = (src_m.group(1) if src_m else "").strip()
        if not src:
            return "（README 内 HTML 图片标签，已省略）"
        lu = src.lower()
        if lu.startswith(("http://", "https://", "//")):
            return f"[图片]({src})"
        return f"（README 内图片（未复制到 Wiki）：`{src}`）"

    return _README_HTML_IMG.sub(repl_html, text)


def _readme_excerpt(files: list[tuple[str, str]], limit: int = 6000) -> str:
    for path, content in files:
        if path.replace("\\", "/").lower().endswith("readme.md"):
            text = content[:limit]
            if len(content) > limit:
                text += "\n\n…（已截断）"
            return _sanitize_readme_for_wiki_markdown(text)
    return ""


def _architecture_markdown(
    project_id: str,
    repo_path: Path,
    chunks: list[dict[str, Any]],
    tree_text: str,
    ws: WikiI18n,
    project_name: str = "",
) -> str:
    pname = (project_name or "").strip()
    if pname:
        project_header = (
            ws.project_info_h2
            + ws.project_name_bullet.format(pname=pname)
            + ws.project_id_bullet.format(pid=project_id)
        )
    else:
        project_header = ws.project_info_h2 + ws.project_id_bullet.format(pid=project_id)

    samples: list[str] = []
    for c in chunks[:ARCH_SAMPLE_CHUNKS]:
        p = _normalize_rel_path(str(c.get("path", "")))
        n = str(c.get("name", ""))
        k = str(c.get("kind", "function"))
        summary = _wiki_llm_function_description(c, ws)
        line = f"- `{p}` :: `{n}` ({k}) — {summary}"
        samples.append(line)

    samples_block = "\n".join(samples)
    client = get_llm_client()
    if not client:
        return (
            f"# {ws.arch_md_h1}\n\n"
            + project_header
            + ws.arch_no_llm_intro
            + "\n\n"
            + f"## {ws.arch_tree_heading}\n\n```text\n{tree_text}\n```\n\n"
            + f"## {ws.arch_samples_heading}\n\n"
            + samples_block
            + "\n"
        )

    if pname:
        pname_line = ws.pname_line_with_name.format(pname=pname, pid=project_id)
    else:
        pname_line = ws.pname_line_id_only.format(pid=project_id)
    user = ws.arch_user_prompt.format(pname_line=pname_line, tree_text=tree_text, samples=samples_block)
    try:
        body = client.chat(
            system=ws.arch_system,
            user=user,
        ).strip()
        if body:
            return body
    except Exception as e:
        logger.warning("Architecture LLM failed: %s", e)
    return (
        f"# {ws.arch_md_h1}\n\n"
        + ws.arch_llm_fail_note
        + "\n\n"
        + project_header
        + f"## {ws.arch_tree_heading}\n\n```text\n{tree_text}\n```\n\n"
        + f"## {ws.arch_samples_heading}\n\n"
        + samples_block
        + "\n"
    )


def _write_file_pages(
    docs_dir: Path,
    by_file: dict[str, list[dict[str, Any]]],
    slug_map: dict[str, str],
    max_pages: int,
    ws: WikiI18n,
    *,
    use_pymdownx_admonitions: bool,
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
        title_esc = _safe_yaml_double_quoted_title(path_norm)
        desc_esc = _safe_yaml_double_quoted_title(ws.file_page_desc.format(path=path_norm))
        lines: list[str] = [
            "---",
            f'title: "{title_esc}"',
            f'description: "{desc_esc}"',
            "---",
            "",
            f"# `{path_norm}`",
            "",
            ws.lang_ext_label.format(ext=ext or "n/a"),
            ws.sym_count_label.format(n=len(syms)),
            "",
            ws.sym_list_h2,
            "",
        ]
        for c in sorted(syms, key=lambda x: (int(x.get("start_line") or 0), str(x.get("name", "")))):
            name = str(c.get("name", ""))
            kind = str(c.get("kind", "function"))
            sl = c.get("start_line")
            el = c.get("end_line")
            llm_desc = _wiki_llm_function_description(c, ws)
            calls = c.get("calls") or []
            anchor = _symbol_anchor(kind, name)
            lines.append(_file_symbol_heading(name, kind, anchor))
            lines.append("")
            lines.append(ws.func_desc_llm_label)
            lines.extend(_md_list_item_body(llm_desc))
            src_doc = _wiki_source_docstring_supplement(c, ws)
            if src_doc:
                lines.append("")
                lines.append(ws.source_doc_bullet)
                lines.extend(_md_list_item_body(src_doc))
            lines.append("")
            if el:
                lines.append(ws.pos_lines_range.format(sl=sl, el=el))
            else:
                lines.append(ws.pos_lines_from.format(sl=sl))
            if calls:
                lines.append(f"{ws.calls_label}{', '.join(str(x) for x in calls[:40])}")
            code = (c.get("code") or "").strip()
            if code:
                snippet = code[:MAX_CODE_IN_WIKI]
                if len(code) > MAX_CODE_IN_WIKI:
                    snippet += ws.truncated_comment
                if use_pymdownx_admonitions:
                    lines.extend(["", ws.code_extract_admonition, "", "```text", snippet, "```", ""])
                else:
                    lines.extend(
                        [
                            "",
                            "<details>",
                            f"<summary>{ws.code_extract_summary_text}</summary>",
                            "",
                            "```text",
                            snippet,
                            "```",
                            "",
                            "</details>",
                            "",
                        ]
                    )
            lines.append("")
        (files_dir / f"{slug}.md").write_text("\n".join(lines), encoding="utf-8")


def _write_symbol_index_parts(
    docs_dir: Path,
    chunks: list[dict[str, Any]],
    slug_map: dict[str, str],
    rows_per_file: int,
    paths_with_file_page: set[str],
    ws: WikiI18n,
    *,
    mkdocs_style_links: bool,
    node_deploy_prefix: str | None,
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
        title = ws.sym_idx_title if pi == 0 else ws.sym_idx_part_title.format(n=pi + 1)
        title_esc = _safe_yaml_double_quoted_title(title)
        desc_esc = _safe_yaml_double_quoted_title(ws.sym_idx_desc_yaml)
        lines: list[str] = [
            "---",
            f'title: "{title_esc}"',
            f'description: "{desc_esc}"',
            "---",
            "",
            ws.sym_idx_h1,
            "",
            ws.sym_idx_intro,
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
                href = _wiki_link_to_file_page(
                    slug, mkdocs_style=mkdocs_style_links, node_deploy_prefix=node_deploy_prefix
                )
                lines.append(ws.open_file_page_link.format(href=href))
                lines.append("")
            lines.append(f"| {ws.tbl_symbol} | {ws.tbl_kind} | {ws.tbl_lines} | {ws.tbl_desc} |")
            lines.append("| --- | --- | --- | --- |")
            for c in file_chunks:
                sym_name = str(c.get("name", ""))
                kind = str(c.get("kind", ""))
                sl = c.get("start_line", "")
                el = c.get("end_line", "")
                row_line = f"{sl}-{el}" if el else str(sl)
                desc = _escape_md_table_cell(_wiki_llm_function_description(c, ws))
                anchor = _symbol_anchor(kind, sym_name)
                sym_cell = (
                    f"[`{_escape_md_table_cell(sym_name)}`]("
                    f"{_wiki_link_to_file_page(slug, mkdocs_style=mkdocs_style_links, anchor=anchor, node_deploy_prefix=node_deploy_prefix)})"
                )
                if path_norm not in paths_with_file_page:
                    sym_cell = f"`{_escape_md_table_cell(sym_name)}`"
                lines.append(f"| {sym_cell} | `{kind}` | {row_line} | {desc} |")
            lines.append("")
        (docs_dir / md_filename).write_text("\n".join(lines), encoding="utf-8")
    return nav_names


def _write_wiki_documentation(
    docs_dir: Path,
    ctx: WikiDocContext,
    *,
    use_pymdownx_admonitions: bool,
    node_deploy_prefix: str | None = None,
) -> list[str]:
    """写入各后端共用的 Markdown；返回符号索引分卷文件名列表（用于侧栏）。

    node_deploy_prefix：Starlight/VitePress 时传入与 FastAPI 挂载一致的 URL 前缀（如 /wiki/<safe>/site/），
    用于正文内链到 files/<slug>/；MkDocs 时勿传。
    """
    pname = (ctx.project_name or "").strip()
    project_id = ctx.project_id
    ws = ctx.i18n

    idx_desc_esc = _safe_yaml_double_quoted_title(ws.index_desc_yaml)
    index_lines = [
        "---",
        f'title: "{ctx.page_title}"',
        f'description: "{idx_desc_esc}"',
        "---",
        "",
        f"# {ctx.h1_line}",
        "",
        ws.meta_h2,
        "",
    ]
    if pname:
        index_lines.extend(
            [
                ws.project_name_bullet.format(pname=pname).strip(),
                ws.project_id_bullet.format(pid=project_id).strip(),
            ]
        )
    else:
        index_lines.append(ws.project_id_bullet.format(pid=project_id).strip())
    index_lines.extend(
        [
            ws.git_commit_label.format(commit=ctx.commit),
            ws.gen_time_label.format(t=ctx.generated_at),
            ws.total_units_label.format(n=len(ctx.chunks)),
            ws.files_with_syms_label.format(n=len(ctx.by_file)),
            "",
            ws.ext_dist_h2,
            "",
            f"| {ws.ext_col} | {ws.files_col} |",
            "| --- | --- |",
        ]
    )
    for ext, cnt in sorted(ctx.ext_counts.items(), key=lambda x: -x[1])[:40]:
        index_lines.append(f"| `{ext}` | {cnt} |")
    index_lines.extend(
        [
            "",
            ws.usage_h2,
            "",
            ws.usage_search,
            "",
            ws.usage_feature_line,
            "",
        ]
    )
    if ctx.readme:
        index_lines.extend([ws.readme_h2, "", ctx.readme, ""])
    (docs_dir / "index.md").write_text("\n".join(index_lines), encoding="utf-8")

    arch_body = _architecture_markdown(
        project_id, ctx.repo_path, ctx.chunks, ctx.tree_text, ws, project_name=pname
    )
    # Starlight：去掉正文重复的一级标题
    h1_esc = re.escape(ws.arch_md_h1)
    arch_body = re.sub(rf"^#\s*{h1_esc}\s*\n+", "", arch_body.lstrip(), count=1)
    arch_title = _safe_yaml_double_quoted_title(ws.arch_title_yaml)
    arch_desc = _safe_yaml_double_quoted_title(ws.arch_desc_yaml)
    arch_doc = (
        "---\n"
        f'title: "{arch_title}"\n'
        f'description: "{arch_desc}"\n'
        "---\n\n"
        + arch_body
    )
    (docs_dir / "architecture.md").write_text(arch_doc, encoding="utf-8")

    sorted_file_items = sorted(ctx.by_file.items(), key=lambda x: x[0])
    paths_with_file_page = {p for p, _ in sorted_file_items[: ctx.max_file_pages]}

    tree_root = _DirNode()
    for path_norm, syms in sorted_file_items:
        slug = ctx.slug_map[path_norm]
        has_page = path_norm in paths_with_file_page
        _file_tree_insert(tree_root, path_norm, slug, len(syms), has_page)
    tree_lines = _render_file_tree_md(
        tree_root,
        ws,
        mkdocs_style_links=use_pymdownx_admonitions,
        node_deploy_prefix=node_deploy_prefix,
    )
    overflow_files = len(ctx.by_file) - min(len(ctx.by_file), ctx.max_file_pages)
    fi_title_esc = _safe_yaml_double_quoted_title(ws.fi_title_yaml)
    fi_desc_esc = _safe_yaml_double_quoted_title(ws.fi_desc_yaml)
    fi_lines = [
        "---",
        f'title: "{fi_title_esc}"',
        f'description: "{fi_desc_esc}"',
        "---",
        "",
        ws.fi_h1,
        "",
        ws.fi_intro,
        "",
        *tree_lines,
        "",
    ]
    if overflow_files > 0:
        fi_lines.append(
            ws.fi_overflow.format(max_pages=ctx.max_file_pages, overflow=overflow_files)
        )
        fi_lines.append("")

    note_q = ws.fi_flat_list_summary.replace('"', '\\"')
    if use_pymdownx_admonitions:
        fi_lines.extend(
            [
                f'??? note "{note_q}"',
                f"    | {ws.fi_tbl_path} | {ws.fi_tbl_syms} | {ws.fi_tbl_doc} |",
                "    | --- | ---: | --- |",
            ]
        )
        row_prefix = "    "
    else:
        fi_lines.extend(
            [
                "<details>",
                f"<summary>{ws.fi_flat_list_summary}</summary>",
                "",
                f"| {ws.fi_tbl_path} | {ws.fi_tbl_syms} | {ws.fi_tbl_doc} |",
                "| --- | ---: | --- |",
            ]
        )
        row_prefix = ""

    for i, (path_norm, syms) in enumerate(sorted_file_items):
        if i >= ctx.max_file_pages:
            fi_lines.append(row_prefix + ws.fi_more_files_row.format(n=overflow_files))
            break
        slug = ctx.slug_map[path_norm]
        open_href = _wiki_link_to_file_page(
            slug,
            mkdocs_style=use_pymdownx_admonitions,
            node_deploy_prefix=node_deploy_prefix,
        )
        fi_lines.append(
            f"{row_prefix}| `{_escape_md_table_cell(path_norm)}` | {len(syms)} | [{ws.fi_open}]({open_href}) |"
        )
    if not use_pymdownx_admonitions:
        fi_lines.extend(["", "</details>"])
    fi_lines.append("")
    (docs_dir / "file-index.md").write_text("\n".join(fi_lines), encoding="utf-8")

    _write_file_pages(
        docs_dir,
        ctx.by_file,
        ctx.slug_map,
        ctx.max_file_pages,
        ws,
        use_pymdownx_admonitions=use_pymdownx_admonitions,
    )
    return _write_symbol_index_parts(
        docs_dir,
        ctx.chunks,
        ctx.slug_map,
        ctx.rows_per,
        paths_with_file_page,
        ws,
        mkdocs_style_links=use_pymdownx_admonitions,
        node_deploy_prefix=node_deploy_prefix,
    )


def generate_project_wiki(
    project_id: str,
    repo_path: Path,
    chunks: list[dict[str, Any]],
    collected_files: list[tuple[str, str]] | None = None,
    project_name: str = "",
) -> dict[str, Any]:
    """
    生成静态 Wiki 源文件并执行 build。失败时抛出异常（由 indexer 捕获）。
    project_name：可选展示名（如中文项目名），由触发接口或 Webhook 传入。
    """
    if not effective_wiki_enabled():
        return {"skipped": True, "reason": "wiki_disabled"}

    pname = (project_name or "").strip()
    safe = _safe_project_id(project_id)
    # 与 app.main 中 StaticFiles(directory=wiki_sites) 挂载到 /wiki 的路径一致（用于 Astro/VitePress base）
    wiki_browse_base = f"/wiki/{safe}/site/"
    wiki_root = settings.data_path / "wiki_sites" / safe
    work_dir = settings.data_path / "wiki_work" / safe
    site_out = wiki_root / "site"

    max_file_pages = effective_wiki_max_file_pages()
    rows_per = effective_wiki_symbol_rows_per_file()

    backend = str(effective_wiki_backend()).strip().lower()
    if backend not in ("mkdocs", "starlight", "vitepress"):
        logger.warning("未知 WIKI_BACKEND=%s，回退 mkdocs", backend)
        backend = "mkdocs"

    if work_dir.exists():
        shutil.rmtree(work_dir, ignore_errors=True)

    if backend == "starlight":
        docs_dir = work_dir / "src" / "content" / "docs"
    else:
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

    ext_counts: dict[str, int] = defaultdict(int)
    for p in by_file:
        ext_counts[_ext_of(p) or "none"] += 1

    readme = _readme_excerpt(collected_files or [], limit=8000)

    ws = wiki_i18n(effective_content_language())
    raw_page_title = (
        ws.page_title_pair.format(pname=pname, pid=project_id)
        if pname
        else ws.wiki_title_suffix.format(pid=project_id)
    )
    page_title = _safe_yaml_double_quoted_title(raw_page_title)
    site_title = f"{pname} · {project_id}" if pname else f"Wiki — {project_id}"
    h1_line = pname if pname else project_id

    ctx = WikiDocContext(
        project_id=project_id,
        repo_path=repo_path,
        project_name=pname,
        commit=commit,
        generated_at=generated_at,
        chunks=chunks,
        by_file=dict(by_file),
        slug_map=slug_map,
        ext_counts=dict(ext_counts),
        readme=readme,
        tree_text=tree_text,
        page_title=page_title,
        site_title=site_title,
        h1_line=h1_line,
        max_file_pages=max_file_pages,
        rows_per=rows_per,
        i18n=ws,
    )

    use_pymdownx = backend == "mkdocs"
    symbol_nav = _write_wiki_documentation(
        docs_dir,
        ctx,
        use_pymdownx_admonitions=use_pymdownx,
        node_deploy_prefix=None if use_pymdownx else wiki_browse_base,
    )

    site_out.parent.mkdir(parents=True, exist_ok=True)

    if backend == "mkdocs":
        nav = [
            {ws.mkdocs_nav_home: "index.md"},
            {ws.mkdocs_nav_arch: "architecture.md"},
            {ws.mkdocs_nav_files: "file-index.md"},
        ]
        if len(symbol_nav) == 1:
            nav.append({ws.mkdocs_nav_symbols: symbol_nav[0]})
        else:
            nested = [{ws.mkdocs_nav_part.format(n=i + 1): n} for i, n in enumerate(symbol_nav)]
            nav.append({ws.mkdocs_nav_symbols_multi.format(n=len(symbol_nav)): nested})

        mkdocs_path = work_dir / "mkdocs.yml"
        mk_lang = "zh" if ws.lang == "zh" else "en"
        search_lang = ["zh"] if ws.lang == "zh" else ["en"]
        mkdocs_content: dict[str, Any] = {
            "site_name": site_title,
            "docs_dir": "docs",
            "site_dir": str(site_out.resolve()),
            "theme": {
                "name": "material",
                "language": mk_lang,
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
            "plugins": [
                {"search": {"lang": search_lang}},
            ],
            "nav": nav,
        }
        mkdocs_path.write_text(
            yaml.safe_dump(mkdocs_content, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
        logger.info(
            "Running mkdocs build backend=%s project=%s work_dir=%s",
            backend,
            project_id,
            work_dir,
        )
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
    elif backend == "starlight":
        logger.info(
            "Running Starlight build backend=%s project=%s work_dir=%s",
            backend,
            project_id,
            work_dir,
        )
        build_starlight_site(
            work_dir,
            site_out,
            site_title,
            symbol_nav,
            public_base=wiki_browse_base,
            wiki_ui=ws,
        )
    else:
        logger.info(
            "Running VitePress build backend=%s project=%s work_dir=%s",
            backend,
            project_id,
            work_dir,
        )
        build_vitepress_site(
            work_dir,
            site_out,
            site_title,
            symbol_nav,
            public_base=wiki_browse_base,
            wiki_ui=ws,
        )

    manifest = {
        "project_id": project_id,
        "project_name": pname or None,
        "safe_id": safe,
        "commit": commit,
        "generated_at": generated_at,
        "chunk_count": len(chunks),
        "file_count_with_symbols": len(by_file),
        "wiki_backend": backend,
        "site_dir": str(site_out.resolve()),
        "browse_url_path": wiki_browse_base,
    }
    wiki_root.mkdir(parents=True, exist_ok=True)
    (wiki_root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    if os.environ.get("WIKI_KEEP_WORK", "").strip().lower() not in ("1", "true", "yes"):
        shutil.rmtree(work_dir, ignore_errors=True)

    logger.info("Wiki built (%s) for %s -> %s", backend, project_id, site_out)
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
