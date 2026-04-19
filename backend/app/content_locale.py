"""
索引 / Wiki 生成内容的语言：zh（默认）与 en。

与前端界面语言独立；由 CONTENT_LANGUAGE 环境变量或管理后台 ui_overrides 配置。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal


def normalize_content_lang(code: str) -> Literal["zh", "en"]:
    s = (code or "zh").strip().lower()
    if s.startswith("en"):
        return "en"
    return "zh"


@dataclass(frozen=True)
class WikiI18n:
    """Wiki 站点 Markdown、侧栏、MkDocs 导航等文案。"""

    lang: Literal["zh", "en"]
    # 404 / Starlight
    not_found_tagline: str
    # 侧栏 / nav
    nav_home: str
    nav_architecture: str
    nav_file_index: str
    nav_symbol_index: str
    nav_symbol_index_part: str  # {n}
    nav_symbol_index_multi: str  # {n}
    # 页面标题类
    wiki_title_suffix: str  # "项目 Wiki — {pid}" 英文版
    page_title_pair: str  # "{pname}（{pid}）" / "{pname} ({pid})"
    # 架构页
    arch_md_h1: str
    arch_title_yaml: str
    arch_desc_yaml: str
    arch_no_llm_intro: str
    arch_tree_heading: str
    arch_samples_heading: str
    arch_user_prompt: str  # 不含动态块，用 format 注入 pname_line, tree_text, samples
    arch_system: str
    arch_fallback_suffix: str
    arch_llm_fail_note: str
    # 项目信息块（架构无 LLM）
    project_info_h2: str
    project_name_bullet: str
    project_id_bullet: str
    pname_line_with_name: str  # {pname}{pid}
    pname_line_id_only: str  # {pid}
    # 截断
    trim_truncated: str
    # LLM 描述占位
    wiki_desc_none_file: str
    wiki_desc_none_fn: str
    # 文件页 YAML / 正文
    file_page_desc: str  # description in yaml
    lang_ext_label: str
    sym_count_label: str
    sym_list_h2: str
    func_desc_llm_label: str
    source_doc_h2: str
    source_doc_bullet: str
    pos_lines_range: str
    pos_lines_from: str
    calls_label: str
    code_extract_admonition: str
    code_extract_summary_text: str
    truncated_comment: str
    # 符号索引
    sym_idx_title: str
    sym_idx_desc_yaml: str
    sym_idx_h1: str
    sym_idx_intro: str
    sym_idx_part_title: str  # {n}
    open_file_page_link: str
    tbl_symbol: str
    tbl_kind: str
    tbl_lines: str
    tbl_desc: str
    # 首页 index.md
    index_desc_yaml: str
    meta_h2: str
    git_commit_label: str
    gen_time_label: str
    total_units_label: str
    files_with_syms_label: str
    ext_dist_h2: str
    ext_col: str
    files_col: str
    usage_h2: str
    usage_search: str
    usage_feature_line: str
    readme_h2: str
    # 文件索引
    fi_title_yaml: str
    fi_desc_yaml: str
    fi_h1: str
    fi_intro: str
    fi_overflow: str  # {max_pages}{overflow}
    fi_flat_list_summary: str
    fi_tbl_path: str
    fi_tbl_syms: str
    fi_tbl_doc: str
    fi_open: str
    fi_more_files_row: str
    # 文件树行
    ft_symbols_line: str  # {fname}{href}{cnt}
    ft_symbols_plain: str  # {fname}{cnt}
    ft_no_page_hint: str
    # mkdocs nav（与 YAML key 一致）
    mkdocs_nav_home: str
    mkdocs_nav_arch: str
    mkdocs_nav_files: str
    mkdocs_nav_symbols: str
    mkdocs_nav_part: str  # {n}
    mkdocs_nav_symbols_multi: str  # {n}


WIKI_ZH = WikiI18n(
    lang="zh",
    not_found_tagline="未找到页面。请检查网址或使用站内搜索。",
    nav_home="首页",
    nav_architecture="架构总览",
    nav_file_index="文件索引",
    nav_symbol_index="符号索引",
    nav_symbol_index_part="符号索引（第 {n} 部分）",
    nav_symbol_index_multi="符号索引（共 {n} 部分）",
    wiki_title_suffix="项目 Wiki — {pid}",
    page_title_pair="{pname}（{pid}）",
    arch_md_h1="架构与功能总览",
    arch_title_yaml="架构与功能总览",
    arch_desc_yaml="基于目录树与代码单元摘要的自动说明（可能含 LLM 生成内容）",
    arch_no_llm_intro="未配置 LLM，无法自动生成架构说明。以下为目录树节选与代码单元列表，请使用左侧搜索或「符号索引」浏览。",
    arch_tree_heading="目录树（节选）",
    arch_samples_heading="代码单元摘要（节选）",
    arch_user_prompt=(
        "你是资深软件架构师。根据下面「目录树节选」与「代码单元摘要」，用**中文 Markdown** 写一份「架构与功能总览」。\n\n"
        "必须包含三级标题：## 模块与职责、## 主要数据与控制流、## 与外部系统的交互（若无则写「未从材料中观察到」）。\n"
        "要求：只根据材料推断，不要编造材料中不存在的功能或依赖；可适度使用列表与加粗。\n\n"
        "{pname_line}"
        "## 目录树（节选）\n```text\n{tree_text}\n```\n\n"
        "## 代码单元摘要（节选）\n{samples}\n\n请直接输出 Markdown 正文（从一级标题 `# 架构与功能总览` 开始）。"
    ),
    arch_system="只输出 Markdown 正文，不要前言或后语。",
    arch_fallback_suffix="（自动生成失败，以下为节选材料。）",
    arch_llm_fail_note="（自动生成失败，以下为节选材料。）",
    project_info_h2="## 项目信息\n\n",
    project_name_bullet="- **项目名称**: {pname}\n",
    project_id_bullet="- **project_id**: `{pid}`\n\n",
    pname_line_with_name="项目展示名称：`{pname}`\n项目标识 project_id：`{pid}`\n\n",
    pname_line_id_only="项目标识 project_id：`{pid}`\n\n",
    trim_truncated="\n\n…（已截断）",
    wiki_desc_none_file=(
        "（无 LLM 描述：当前为文件级索引，未对单个函数生成说明；"
        "可配置 LLM 并尽量使用函数级解析后重新索引，或查看下方代码摘录。）"
    ),
    wiki_desc_none_fn=(
        "（无 LLM 描述：请在环境中配置 Dify / Azure OpenAI / OpenAI 后重新索引本仓库；"
        "若已配置仍为空，请查看索引日志中 describe 阶段是否报错。）"
    ),
    file_page_desc="文件 {path} 内的符号与说明",
    lang_ext_label="- **语言/扩展名**: `{ext}`",
    sym_count_label="- **符号数量**: {n}",
    sym_list_h2="## 符号列表",
    func_desc_llm_label="- **功能说明**（LLM 生成）:",
    source_doc_h2="### 源码文档",
    source_doc_bullet="- **源码文档**（docstring / 注释）:",
    pos_lines_range="- **位置**: 第 {sl}–{el} 行",
    pos_lines_from="- **位置**: 第 {sl} 行起",
    calls_label="- **调用**: ",
    code_extract_admonition='??? note "代码摘录"',
    code_extract_summary_text="代码摘录",
    truncated_comment="\n\n/* … 已截断 … */",
    sym_idx_title="符号索引",
    sym_idx_desc_yaml="全量符号与所在文件",
    sym_idx_h1="# 符号索引",
    sym_idx_intro="按 **文件** 分组列出符号；长路径只在每组标题出现一次，表格更易阅读。",
    sym_idx_part_title="符号索引（第 {n} 部分）",
    open_file_page_link="[打开该文件说明页]({href})",
    tbl_symbol="符号",
    tbl_kind="类型",
    tbl_lines="行号",
    tbl_desc="功能说明",
    index_desc_yaml="代码索引与符号说明（自动生成）",
    meta_h2="## 元数据",
    git_commit_label="- **Git 提交**: `{commit}`",
    gen_time_label="- **生成时间（UTC）**: {t}",
    total_units_label="- **符号/单元总数**: {n}",
    files_with_syms_label="- **文件数（有符号）**: {n}",
    ext_dist_h2="## 语言 / 扩展名分布",
    ext_col="扩展名",
    files_col="文件数",
    usage_h2="## 使用说明",
    usage_search="使用顶部 **搜索框** 可全文检索路径、函数名与说明。",
    usage_feature_line=(
        "**功能说明** 一栏仅展示索引阶段由 LLM（Dify / OpenAI / Azure OpenAI）生成的描述，与向量语义检索一致；"
        "若未配置 LLM 或生成失败，会显示提示文案。源码中的 docstring 如有且与 LLM 描述不同，会单独出现在 **源码文档** 中。"
    ),
    readme_h2="## README 摘录",
    fi_title_yaml="文件索引",
    fi_desc_yaml="按路径浏览生成的文件说明页",
    fi_h1="# 文件索引",
    fi_intro="按仓库 **目录树** 浏览；点击文件名进入该文件的符号说明页。也可使用顶部 **搜索** 按路径或符号名查找。",
    fi_overflow=(
        "超出单仓页面上限（`WIKI_MAX_FILE_PAGES={max_pages}`）的文件仍出现在上表中，"
        "但**未生成单独文档页**（共 {overflow} 个）；请用搜索或「符号索引」查看。"
    ),
    fi_flat_list_summary="扁平路径列表（备选，便于复制完整路径）",
    fi_tbl_path="路径",
    fi_tbl_syms="符号数",
    fi_tbl_doc="文档",
    fi_open="打开",
    fi_more_files_row="| … | … | *另有 {n} 个文件未单独建页* |",
    ft_symbols_line="- [{fname}]({href}) — {cnt} 个符号",
    ft_symbols_plain="- `{fname}` — {cnt} 个符号（未生成单独页面，请用顶部搜索）",
    ft_no_page_hint="",
    mkdocs_nav_home="首页",
    mkdocs_nav_arch="架构总览",
    mkdocs_nav_files="文件索引",
    mkdocs_nav_symbols="符号索引",
    mkdocs_nav_part="第 {n} 部分",
    mkdocs_nav_symbols_multi="符号索引（共 {n} 部分）",
)

WIKI_EN = WikiI18n(
    lang="en",
    not_found_tagline="Page not found. Check the URL or use site search.",
    nav_home="Home",
    nav_architecture="Architecture",
    nav_file_index="File index",
    nav_symbol_index="Symbol index",
    nav_symbol_index_part="Symbol index (part {n})",
    nav_symbol_index_multi="Symbol index ({n} parts)",
    wiki_title_suffix="Project wiki — {pid}",
    page_title_pair="{pname} ({pid})",
    arch_md_h1="Architecture overview",
    arch_title_yaml="Architecture overview",
    arch_desc_yaml="Auto-generated from tree and code units (may include LLM text)",
    arch_no_llm_intro=(
        "LLM is not configured; cannot auto-generate architecture text. "
        "Below is an excerpt of the directory tree and code units—use search or the symbol index."
    ),
    arch_tree_heading="Directory tree (excerpt)",
    arch_samples_heading="Code units (excerpt)",
    arch_user_prompt=(
        "You are a senior software architect. Based on the **directory tree excerpt** and **code unit summaries** below, "
        "write an **English Markdown** document titled **Architecture overview**.\n\n"
        "Include these level-2 sections: ## Modules and responsibilities, ## Main data and control flow, "
        "## External integrations (write \"Not observed from the materials\" if none).\n"
        "Infer only from the materials; do not invent features or dependencies. Use lists and bold where helpful.\n\n"
        "{pname_line}"
        "## Directory tree (excerpt)\n```text\n{tree_text}\n```\n\n"
        "## Code units (excerpt)\n{samples}\n\n"
        "Output Markdown only, starting with the level-1 heading `# Architecture overview`."
    ),
    arch_system="Output Markdown body only; no preamble or closing remarks.",
    arch_fallback_suffix="(Generation failed; excerpt below.)",
    arch_llm_fail_note="(Generation failed; excerpt below.)",
    project_info_h2="## Project\n\n",
    project_name_bullet="- **Project name**: {pname}\n",
    project_id_bullet="- **project_id**: `{pid}`\n\n",
    pname_line_with_name="Display name: `{pname}`\nproject_id: `{pid}`\n\n",
    pname_line_id_only="project_id: `{pid}`\n\n",
    trim_truncated="\n\n… (truncated)",
    wiki_desc_none_file=(
        "(No LLM description: file-level index only; configure LLM and re-index for function-level summaries, "
        "or see the code excerpt below.)"
    ),
    wiki_desc_none_fn=(
        "(No LLM description: configure Dify / Azure OpenAI / OpenAI and re-index; "
        "if already configured, check indexer logs for describe-stage errors.)"
    ),
    file_page_desc="Symbols and notes for {path}",
    lang_ext_label="- **Language / extension**: `{ext}`",
    sym_count_label="- **Symbol count**: {n}",
    sym_list_h2="## Symbols",
    func_desc_llm_label="- **Summary** (LLM):",
    source_doc_h2="### Source docs",
    source_doc_bullet="- **Source docs** (docstring / comments):",
    pos_lines_range="- **Location**: lines {sl}–{el}",
    pos_lines_from="- **Location**: from line {sl}",
    calls_label="- **Calls**: ",
    code_extract_admonition='??? note "Code excerpt"',
    code_extract_summary_text="Code excerpt",
    truncated_comment="\n\n/* … truncated … */",
    sym_idx_title="Symbol index",
    sym_idx_desc_yaml="All symbols and source files",
    sym_idx_h1="# Symbol index",
    sym_idx_intro="Symbols grouped by **file**; long paths appear once per group for readability.",
    sym_idx_part_title="Symbol index (part {n})",
    open_file_page_link="[Open file page]({href})",
    tbl_symbol="Symbol",
    tbl_kind="Kind",
    tbl_lines="Lines",
    tbl_desc="Summary",
    index_desc_yaml="Code index and symbol notes (auto-generated)",
    meta_h2="## Metadata",
    git_commit_label="- **Git commit**: `{commit}`",
    gen_time_label="- **Generated at (UTC)**: {t}",
    total_units_label="- **Total units**: {n}",
    files_with_syms_label="- **Files with symbols**: {n}",
    ext_dist_h2="## Extensions",
    ext_col="Extension",
    files_col="Files",
    usage_h2="## Usage",
    usage_search="Use the **search** box to find paths, names, and descriptions.",
    usage_feature_line=(
        "**Summary** shows LLM text from indexing (same as semantic search). "
        "If LLM is missing or failed, placeholders appear. **Source docs** lists docstrings when they differ from the LLM text."
    ),
    readme_h2="## README excerpt",
    fi_title_yaml="File index",
    fi_desc_yaml="Browse generated file pages by path",
    fi_h1="# File index",
    fi_intro="Browse the **directory tree**; click a file to open its symbol page. Use **search** by path or symbol name.",
    fi_overflow=(
        "Files beyond the page limit (`WIKI_MAX_FILE_PAGES={max_pages}`) still appear below but "
        "**have no dedicated page** ({overflow} files); use search or the symbol index."
    ),
    fi_flat_list_summary="Flat path list (copy-friendly)",
    fi_tbl_path="Path",
    fi_tbl_syms="Symbols",
    fi_tbl_doc="Page",
    fi_open="Open",
    fi_more_files_row="| … | … | *{n} more files without pages* |",
    ft_symbols_line="- [{fname}]({href}) — {cnt} symbols",
    ft_symbols_plain="- `{fname}` — {cnt} symbols (no dedicated page; use search)",
    ft_no_page_hint="",
    mkdocs_nav_home="Home",
    mkdocs_nav_arch="Architecture",
    mkdocs_nav_files="File index",
    mkdocs_nav_symbols="Symbol index",
    mkdocs_nav_part="Part {n}",
    mkdocs_nav_symbols_multi="Symbol index ({n} parts)",
)


def wiki_i18n(lang: str) -> WikiI18n:
    return WIKI_EN if normalize_content_lang(lang) == "en" else WIKI_ZH


def describe_batch_system_user(lang: str) -> tuple[str, str]:
    """describe_functions_batch system and user prefixes."""
    output_lang = "English" if normalize_content_lang(lang) == "en" else "Chinese"
    system = (
        "You are a code analysis assistant. For each input item, output exactly one JSON object in ONE line. "
        "Required keys: idx (integer), summary (string), functionality (array of 2-4 short strings), tags (array of 3-5 keywords). "
        "Return JSONL only (one JSON object per input item, in the same order). "
        "Do not include markdown, numbering, or code fences. "
        f"Write all natural-language fields in {output_lang}."
    )
    user_head = (
        "Each item below is either a function/method or a UI template/markup fragment. "
        "For functions/methods, summarize logic, inputs, outputs, and side effects. "
        "For templates, summarize structure, interaction, and bindings. "
        "Use only information present in code. Set idx from the bracket prefix like [0], [1], ... . "
        "Output JSONL only:\n\n"
    )
    return system, user_head


def analyze_repo_system_user(lang: str, project_id: str, files_context: str) -> tuple[str, str]:
    """System and user prompts for repository feature analysis."""
    output_lang = "English" if normalize_content_lang(lang) == "en" else "Chinese"
    system = (
        "You are a code assistant. From the project files, write concise feature notes.\n"
        "1. Group by module or file and explain what the code does and what it exposes.\n"
        "2. Produce multiple sections; each section should start with [module or path] followed by a short paragraph.\n"
        "3. Do not paste large code blocks; use natural language only.\n"
        f"4. Write the final answer in {output_lang}."
    )
    user = (
        f"Project id: {project_id}\n\n"
        "Analyze the following code and produce feature notes with multiple sections "
        "(each section corresponds to one module or file):\n\n"
        f"{files_context}\n\n"
        "Output only the sectioned feature notes."
    )
    return system, user


def index_progress_messages(lang: str) -> dict[str, str]:
    """索引任务进度 step -> 简短说明。"""
    if normalize_content_lang(lang) == "en":
        return {
            "clone_or_pull": "Cloning / pulling repository",
            "collect_files": "Scanning source files",
            "parse_functions": "Parsing functions",
            "describe_chunks": "Generating LLM descriptions (if configured)",
            "generate_wiki": "Building static wiki",
            "upsert_vector_store": "Embedding and writing to vector store",
            "done": "Finishing",
        }
    return {
        "clone_or_pull": "克隆/拉取仓库中",
        "collect_files": "扫描代码文件中",
        "parse_functions": "函数级解析中",
        "describe_chunks": "生成函数说明中（如已配置 LLM）",
        "generate_wiki": "生成静态 Wiki 中",
        "upsert_vector_store": "向量化并写入向量库中",
        "done": "收尾中",
    }


def index_parse_progress_msg(lang: str, done: int, total: int) -> str:
    if normalize_content_lang(lang) == "en":
        return f"Parsing functions ({done}/{total} files)"
    return f"函数级解析中（{done}/{total} 个文件）"


def index_done_messages(lang: str) -> tuple[str, str, str]:
    """done 状态：success, failed prefix, failed generic."""
    if normalize_content_lang(lang) == "en":
        return "Complete", "Failed: ", "Failed"
    return "完成", "失败: ", "失败"


def index_generic_processing(lang: str) -> str:
    return "Processing" if normalize_content_lang(lang) == "en" else "处理中"
