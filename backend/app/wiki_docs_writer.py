from __future__ import annotations

from itertools import groupby
from pathlib import Path
from typing import Any, Callable


def write_file_pages(
    docs_dir: Path,
    by_file: dict[str, list[dict[str, Any]]],
    slug_map: dict[str, str],
    max_pages: int,
    ws: Any,
    *,
    use_pymdownx_admonitions: bool,
    max_code_in_wiki: int,
    normalize_rel_path_fn: Callable[[str], str],
    ext_of_fn: Callable[[str], str],
    safe_yaml_double_quoted_title_fn: Callable[[str], str],
    wiki_llm_function_description_fn: Callable[[dict[str, Any], Any], str],
    wiki_source_docstring_supplement_fn: Callable[[dict[str, Any], Any], str | None],
    symbol_anchor_fn: Callable[[str, str], str],
    file_symbol_heading_fn: Callable[[str, str, str], str],
    md_list_item_body_fn: Callable[[str], list[str]],
) -> None:
    files_dir = docs_dir / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    items = sorted(by_file.items(), key=lambda x: x[0])
    for i, (rel_path, syms) in enumerate(items):
        if i >= max_pages:
            break
        slug = slug_map[rel_path]
        path_norm = normalize_rel_path_fn(rel_path)
        ext = ext_of_fn(path_norm)
        title_esc = safe_yaml_double_quoted_title_fn(path_norm)
        desc_esc = safe_yaml_double_quoted_title_fn(ws.file_page_desc.format(path=path_norm))
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
            llm_desc = wiki_llm_function_description_fn(c, ws)
            calls = c.get("calls") or []
            anchor = symbol_anchor_fn(kind, name)
            lines.append(file_symbol_heading_fn(name, kind, anchor))
            lines.append("")
            lines.append(ws.func_desc_llm_label)
            lines.extend(md_list_item_body_fn(llm_desc))
            src_doc = wiki_source_docstring_supplement_fn(c, ws)
            if src_doc:
                lines.append("")
                lines.append(ws.source_doc_bullet)
                lines.extend(md_list_item_body_fn(src_doc))
            lines.append("")
            if el:
                lines.append(ws.pos_lines_range.format(sl=sl, el=el))
            else:
                lines.append(ws.pos_lines_from.format(sl=sl))
            if calls:
                lines.append(f"{ws.calls_label}{', '.join(str(x) for x in calls[:40])}")
            code = (c.get("code") or "").strip()
            if code:
                snippet = code[:max_code_in_wiki]
                if len(code) > max_code_in_wiki:
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


def write_symbol_index_parts(
    docs_dir: Path,
    chunks: list[dict[str, Any]],
    slug_map: dict[str, str],
    rows_per_file: int,
    paths_with_file_page: set[str],
    ws: Any,
    *,
    mkdocs_style_links: bool,
    node_deploy_prefix: str | None,
    normalize_rel_path_fn: Callable[[str], str],
    file_slug_fn: Callable[[str], str],
    escape_md_table_cell_fn: Callable[[str], str],
    wiki_llm_function_description_fn: Callable[[dict[str, Any], Any], str],
    symbol_anchor_fn: Callable[[str, str], str],
    wiki_link_to_file_page_fn: Callable[..., str],
) -> list[str]:
    nav_names: list[str] = []
    sorted_chunks = sorted(
        chunks,
        key=lambda x: (normalize_rel_path_fn(str(x.get("path", ""))), str(x.get("name", ""))),
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
        title_esc = (title or "").replace("\\", "\\\\").replace('"', '\\"')
        desc_esc = ((ws.sym_idx_desc_yaml or "")).replace("\\", "\\\\").replace('"', '\\"')
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
            key=lambda x: normalize_rel_path_fn(str(x.get("path", ""))),
        ):
            file_chunks = list(file_chunks_iter)
            slug = slug_map.get(path_norm, file_slug_fn(path_norm))
            path_esc = escape_md_table_cell_fn(path_norm)
            lines.append(f"## `{path_esc}`")
            lines.append("")
            if path_norm in paths_with_file_page:
                href = wiki_link_to_file_page_fn(
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
                desc = escape_md_table_cell_fn(wiki_llm_function_description_fn(c, ws))
                anchor = symbol_anchor_fn(kind, sym_name)
                sym_cell = (
                    f"[`{escape_md_table_cell_fn(sym_name)}`]("
                    f"{wiki_link_to_file_page_fn(slug, mkdocs_style=mkdocs_style_links, anchor=anchor, node_deploy_prefix=node_deploy_prefix)})"
                )
                if path_norm not in paths_with_file_page:
                    sym_cell = f"`{escape_md_table_cell_fn(sym_name)}`"
                lines.append(f"| {sym_cell} | `{kind}` | {row_line} | {desc} |")
            lines.append("")
        (docs_dir / md_filename).write_text("\n".join(lines), encoding="utf-8")
    return nav_names
