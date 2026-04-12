"""
Tree-sitter 函数级解析：从源码中提取函数/方法为独立 chunk，便于精确检索「功能是否在代码中实现」。
Vue SFC：单独抽取 <template> 为模板 chunk，仅对 <script> 内代码做函数级解析并回写行号。
"""
import logging
import re
import time
from typing import Any, Callable, Optional

from tree_sitter import Node, Tree

try:
    from tree_sitter_language_pack import get_parser
    _GET_PARSER_MODULE = "tree_sitter_language_pack"
except ImportError:
    try:
        from tree_sitter_languages import get_parser
        _GET_PARSER_MODULE = "tree_sitter_languages"
    except ImportError:
        get_parser = None  # 无 parser 时索引阶段将无函数级 chunk
        _GET_PARSER_MODULE = ""

logger = logging.getLogger(__name__)

# 扩展名 -> tree-sitter-language-pack 语言名
EXT_TO_LANG: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".vue": "typescript",
    ".go": "go",
    ".java": "java",
    ".cs": "csharp",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "cpp",
    ".hpp": "cpp",
}

_parsers: dict[str, Any] = {}


# 部分 tree-sitter 包用 c_sharp 而非 csharp；tsx 多数包未单独提供，用 typescript 解析
_LANG_ALIASES: dict[str, list[str]] = {"csharp": ["c_sharp"], "tsx": ["typescript"]}


def _get_parser(lang: str):
    if get_parser is None:
        return None
    global _parsers
    if lang not in _parsers:
        try:
            _parsers[lang] = get_parser(lang)
        except Exception as e:
            logger.debug("No parser for %s: %s", lang, e)
            _parsers[lang] = None
        if _parsers[lang] is None and lang in _LANG_ALIASES:
            for alt in _LANG_ALIASES[lang]:
                try:
                    _parsers[lang] = get_parser(alt)
                    break
                except Exception:
                    pass
    return _parsers.get(lang)


def _node_text(source: bytes, node: Node) -> str:
    return source[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def _node_name(node: Node, source: bytes) -> str:
    """从节点中取名称（identifier）。"""
    name_node = node.child_by_field_name("name")
    if name_node:
        return _node_text(source, name_node).strip()
    # 部分语言 name 在别处，用第一个 identifier
    for i in range(node.child_count):
        c = node.child(i)
        if c.type == "identifier":
            return _node_text(source, c).strip()
    return ""


def _collect_call_names(
    source: bytes,
    node: Node,
    call_node_types: tuple[str, ...],
) -> list[str]:
    """
    从给定子树中收集函数/方法调用的名字，返回简单字符串列表。
    仅做轻量级静态分析：提取调用目标中最后一个 identifier（如 obj.foo -> foo）。
    """
    calls: list[str] = []

    def walk(n: Node) -> None:
        if n.type in call_node_types:
            # 常见语法：call_expression / invocation_expression 等
            target = n.child_by_field_name("function") or n.child_by_field_name("expression")
            if target is None:
                # C# invocation_expression 可能直接把目标作为第一个子节点
                if n.child_count > 0:
                    target = n.child(0)
            if target is not None:
                # 寻找目标里的最后一个 identifier 作为被调名称
                last_ident: str | None = None
                stack = [target]
                while stack:
                    cur = stack.pop()
                    if cur.type == "identifier":
                        last_ident = _node_text(source, cur).strip() or last_ident
                    for i in range(cur.child_count - 1, -1, -1):
                        stack.append(cur.child(i))
                if last_ident:
                    calls.append(last_ident)
        for i in range(n.child_count):
            walk(n.child(i))

    walk(node)
    return calls


# --------------- Python ---------------
def _extract_python(source: bytes, tree: Tree, path: str) -> list[dict[str, Any]]:
    root = tree.root_node
    chunks: list[dict[str, Any]] = []

    def walk(node: Node, class_name: str = "") -> None:
        if node.type == "function_definition":
            name = _node_name(node, source)
            if name and not name.startswith("_"):  # 可选：过滤私有
                code = _node_text(source, node)
                kind = "method" if class_name else "function"
                display_name = f"{class_name}.{name}" if class_name else name
                calls = _collect_call_names(source, node, ("call",))
                chunks.append({
                    "path": path,
                    "name": display_name,
                    "kind": kind,
                    "code": code,
                    "start_line": node.start_point[0] + 1,
                    "end_line": node.end_point[0] + 1,
                    "metadata": {"path": path, "name": display_name, "kind": kind},
                    "calls": calls,
                })
        elif node.type == "class_definition":
            cls_name = _node_name(node, source)
            body = node.child_by_field_name("body")
            if body:
                for i in range(body.child_count):
                    walk(body.child(i), class_name=cls_name)
        else:
            for i in range(node.child_count):
                walk(node.child(i), class_name)

    walk(root)
    return chunks


# --------------- JavaScript / TypeScript ---------------
def _extract_js_ts(source: bytes, tree: Tree, path: str) -> list[dict[str, Any]]:
    root = tree.root_node
    chunks: list[dict[str, Any]] = []

    def name_from_node(node: Node) -> str:
        # function_declaration: name 在 declaration 里或直接有 name
        n = node.child_by_field_name("name")
        if n:
            return _node_text(source, n).strip()
        # arrow: 可能无 name，用 "anonymous"
        return "anonymous"

    def walk(node: Node, class_name: str = "") -> None:
        t = node.type
        if t in ("function_declaration", "function", "generator_function_declaration"):
            name = name_from_node(node)
            if name == "anonymous":
                name = "anonymous_" + str(node.start_byte)
            code = _node_text(source, node)
            calls = _collect_call_names(source, node, ("call_expression",))
            kind = "method" if class_name else "function"
            display = f"{class_name}.{name}" if class_name else name
            chunks.append({
                "path": path,
                "name": display,
                "kind": kind,
                "code": code,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "metadata": {"path": path, "name": display, "kind": kind},
                "calls": calls,
            })
        elif t == "method_definition":
            name = name_from_node(node)
            display = f"{class_name}.{name}" if class_name else name
            code = _node_text(source, node)
            calls = _collect_call_names(source, node, ("call_expression",))
            chunks.append({
                "path": path,
                "name": display,
                "kind": "method",
                "code": code,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "metadata": {"path": path, "name": display, "kind": "method"},
                "calls": calls,
            })
        elif t == "class_declaration" or t == "class":
            cls_name = name_from_node(node)
            body = node.child_by_field_name("body")
            if body:
                for i in range(body.child_count):
                    walk(body.child(i), class_name=cls_name)
        elif t == "variable_declarator":
            # React 常见: const Component = () => {} 或 const fn = function() {}
            value = node.child_by_field_name("value")
            name_node = node.child_by_field_name("name")
            if value and name_node and value.type in ("arrow_function", "function"):
                name = _node_text(source, name_node).strip()
                if name:
                    code = _node_text(source, value)
                    calls = _collect_call_names(source, value, ("call_expression",))
                    chunks.append({
                        "path": path,
                        "name": name,
                        "kind": "function",
                        "code": code,
                        "start_line": value.start_point[0] + 1,
                        "end_line": value.end_point[0] + 1,
                        "metadata": {"path": path, "name": name, "kind": "function"},
                        "calls": calls,
                    })
            for i in range(node.child_count):
                walk(node.child(i), class_name)
        else:
            for i in range(node.child_count):
                walk(node.child(i), class_name)

    walk(root)
    return chunks


# --------------- Go ---------------
def _extract_go(source: bytes, tree: Tree, path: str) -> list[dict[str, Any]]:
    root = tree.root_node
    chunks: list[dict[str, Any]] = []

    def walk(node: Node) -> None:
        if node.type in ("function_declaration", "method_declaration"):
            name_node = node.child_by_field_name("name")
            if not name_node:
                # method: name 可能在 receiver 后面
                for i in range(node.child_count):
                    c = node.child(i)
                    if c.type == "identifier":
                        name_node = c
                        break
            name = _node_text(source, name_node).strip() if name_node else "anonymous"
            code = _node_text(source, node)
            kind = "method" if node.type == "method_declaration" else "function"
            chunks.append({
                "path": path,
                "name": name,
                "kind": kind,
                "code": code,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "metadata": {"path": path, "name": name, "kind": kind},
            })
        else:
            for i in range(node.child_count):
                walk(node.child(i))

    walk(root)
    return chunks


# --------------- Java ---------------
def _extract_java(source: bytes, tree: Tree, path: str) -> list[dict[str, Any]]:
    root = tree.root_node
    chunks: list[dict[str, Any]] = []

    def walk(node: Node, class_name: str = "") -> None:
        if node.type == "method_declaration":
            name_node = node.child_by_field_name("name")
            name = _node_text(source, name_node).strip() if name_node else "anonymous"
            code = _node_text(source, node)
            display = f"{class_name}.{name}" if class_name else name
            chunks.append({
                "path": path,
                "name": display,
                "kind": "method" if class_name else "function",
                "code": code,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "metadata": {"path": path, "name": display, "kind": "method"},
            })
        elif node.type == "constructor_declaration":
            name_node = node.child_by_field_name("name")
            name = _node_text(source, name_node).strip() if name_node else class_name or "constructor"
            code = _node_text(source, node)
            display = f"{class_name}.{name}" if class_name else name
            chunks.append({
                "path": path,
                "name": display,
                "kind": "constructor",
                "code": code,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "metadata": {"path": path, "name": display, "kind": "constructor"},
            })
        elif node.type == "class_declaration" or node.type == "interface_declaration":
            name_node = node.child_by_field_name("name")
            cls_name = _node_text(source, name_node).strip() if name_node else ""
            body = node.child_by_field_name("body")
            if body:
                for i in range(body.child_count):
                    walk(body.child(i), class_name=cls_name)
        else:
            for i in range(node.child_count):
                walk(node.child(i), class_name)

    walk(root)
    return chunks


# --------------- Rust ---------------
def _extract_rust(source: bytes, tree: Tree, path: str) -> list[dict[str, Any]]:
    root = tree.root_node
    chunks: list[dict[str, Any]] = []

    def walk(node: Node) -> None:
        if node.type in ("function_item", "method_declaration"):
            name_node = node.child_by_field_name("name")
            name = _node_text(source, name_node).strip() if name_node else "anonymous"
            code = _node_text(source, node)
            kind = "method" if node.type == "method_declaration" else "function"
            chunks.append({
                "path": path,
                "name": name,
                "kind": kind,
                "code": code,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "metadata": {"path": path, "name": name, "kind": kind},
            })
        else:
            for i in range(node.child_count):
                walk(node.child(i))

    walk(root)
    return chunks


# --------------- C# ---------------
def _extract_csharp(source: bytes, tree: Tree, path: str) -> list[dict[str, Any]]:
    root = tree.root_node
    chunks: list[dict[str, Any]] = []

    def walk(node: Node, class_name: str = "") -> None:
        if node.type == "method_declaration":
            name_node = node.child_by_field_name("name")
            name = _node_text(source, name_node).strip() if name_node else "anonymous"
            code = _node_text(source, node)
            calls = _collect_call_names(source, node, ("invocation_expression",))
            display = f"{class_name}.{name}" if class_name else name
            chunks.append({
                "path": path,
                "name": display,
                "kind": "method" if class_name else "function",
                "code": code,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "metadata": {"path": path, "name": display, "kind": "method"},
                "calls": calls,
            })
        elif node.type == "constructor_declaration":
            name_node = node.child_by_field_name("name")
            name = _node_text(source, name_node).strip() if name_node else (class_name or "constructor")
            code = _node_text(source, node)
            calls = _collect_call_names(source, node, ("invocation_expression",))
            display = f"{class_name}.{name}" if class_name else name
            chunks.append({
                "path": path,
                "name": display,
                "kind": "constructor",
                "code": code,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "metadata": {"path": path, "name": display, "kind": "constructor"},
                "calls": calls,
            })
        elif node.type == "destructor_declaration":
            name_node = node.child_by_field_name("name")
            name = _node_text(source, name_node).strip() if name_node else "destructor"
            code = _node_text(source, node)
            calls = _collect_call_names(source, node, ("invocation_expression",))
            display = f"{class_name}.{name}" if class_name else name
            chunks.append({
                "path": path,
                "name": display,
                "kind": "destructor",
                "code": code,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "metadata": {"path": path, "name": display, "kind": "destructor"},
                "calls": calls,
            })
        elif node.type in ("class_declaration", "struct_declaration", "interface_declaration"):
            name_node = node.child_by_field_name("name")
            type_name = _node_text(source, name_node).strip() if name_node else ""
            body = node.child_by_field_name("body")
            if body:
                for i in range(body.child_count):
                    walk(body.child(i), class_name=type_name)
        else:
            for i in range(node.child_count):
                walk(node.child(i), class_name)

    walk(root)
    return chunks


# --------------- C/C++ ---------------
def _extract_c_cpp(source: bytes, tree: Tree, path: str) -> list[dict[str, Any]]:
    root = tree.root_node
    chunks: list[dict[str, Any]] = []

    def walk(node: Node) -> None:
        if node.type == "function_definition":
            decl = node.child_by_field_name("declarator")
            name = "anonymous"
            if decl:
                # declarator -> identifier 或 nested
                id_node = decl.child_by_field_name("declarator")
                if id_node:
                    n = id_node.child_by_field_name("declarator") or id_node
                    for i in range(n.child_count):
                        if n.child(i).type == "identifier":
                            name = _node_text(source, n.child(i)).strip()
                            break
                else:
                    for i in range(decl.child_count):
                        if decl.child(i).type == "identifier":
                            name = _node_text(source, decl.child(i)).strip()
                            break
            code = _node_text(source, node)
            chunks.append({
                "path": path,
                "name": name,
                "kind": "function",
                "code": code,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
                "metadata": {"path": path, "name": name, "kind": "function"},
            })
        else:
            for i in range(node.child_count):
                walk(node.child(i))

    walk(root)
    return chunks


# --------------- Vue SFC ---------------
_VUE_TEMPLATE_RE = re.compile(r"<template(\s[^>]*)?>([\s\S]*?)</template>", re.IGNORECASE)
_VUE_SCRIPT_RE = re.compile(r"<script(\s[^>]*)?>([\s\S]*?)</script>", re.IGNORECASE)


def _line_at_char(content: str, char_index: int) -> int:
    """1-based line number，char_index 为 str 中的字符偏移（与 re.Match.start/end 一致）。"""
    if char_index <= 0:
        return 1
    if char_index >= len(content):
        return content.count("\n") + 1
    return content.count("\n", 0, char_index) + 1


def _vue_skip_script(attrs: str) -> bool:
    a = attrs or ""
    if re.search(r"\bsrc\s*=", a, re.IGNORECASE):
        return True
    if re.search(r'\btype\s*=\s*["\']application/json', a, re.IGNORECASE):
        return True
    return False


def _parse_vue_file(path: str, content: str) -> list[dict[str, Any]]:
    """解析 .vue：模板独立 chunk + 各 <script> 块内函数级 chunk（行号相对整文件）。"""
    chunks: list[dict[str, Any]] = []

    tmpl_idx = 0
    for m in _VUE_TEMPLATE_RE.finditer(content):
        body = (m.group(2) or "").strip()
        if not body:
            continue
        tmpl_idx += 1
        start_c = m.start(2)
        end_c = m.end(2)
        start_line = _line_at_char(content, start_c)
        end_line = _line_at_char(content, end_c - 1 if end_c > start_c else start_c)
        name = "template" if tmpl_idx == 1 else f"template_{tmpl_idx}"
        chunks.append({
            "path": path,
            "name": name,
            "kind": "vue_template",
            "code": body,
            "start_line": start_line,
            "end_line": end_line,
            "metadata": {"path": path, "name": name, "kind": "vue_template"},
            "calls": [],
        })

    parser = _get_parser("typescript")
    extractor = EXTRACTORS.get("typescript")
    if not parser or not extractor:
        return chunks

    for m in _VUE_SCRIPT_RE.finditer(content):
        attrs = m.group(1) or ""
        if _vue_skip_script(attrs):
            continue
        body = m.group(2) or ""
        if not body.strip():
            continue
        line0 = _line_at_char(content, m.start(2))
        offset = line0 - 1
        try:
            tree = parser.parse(body.encode("utf-8"))
            if not tree or not tree.root_node:
                continue
            sub = extractor(body.encode("utf-8"), tree, path)
            for c in sub:
                c["start_line"] = int(c.get("start_line") or 1) + offset
                c["end_line"] = int(c.get("end_line") or 1) + offset
                if isinstance(c.get("metadata"), dict):
                    c["metadata"] = {**c["metadata"], "path": path}
            chunks.extend(sub)
        except Exception as e:
            logger.debug("Vue script parse %s failed: %s", path, e)

    return chunks


EXTRACTORS: dict[str, Any] = {
    "python": _extract_python,
    "javascript": _extract_js_ts,
    "typescript": _extract_js_ts,
    "tsx": _extract_js_ts,
    "go": _extract_go,
    "java": _extract_java,
    "csharp": _extract_csharp,
    "rust": _extract_rust,
    "c": _extract_c_cpp,
    "cpp": _extract_c_cpp,
}


def parse_file(path: str, content: str) -> list[dict[str, Any]]:
    """
    对单个文件做函数级解析，返回 chunk 列表。
    每个 chunk: path, name, kind, code, start_line, end_line, metadata.
    """
    from pathlib import Path
    ext = (Path(path).suffix or "").lower()
    if ext == ".vue":
        try:
            return _parse_vue_file(path, content)
        except Exception as e:
            logger.debug("parse_file vue %s failed: %s", path, e)
            return []
    if ext == ".tsx":
        lang = "tsx"
    else:
        lang = EXT_TO_LANG.get(ext)
    if not lang:
        return []
    parser = _get_parser(lang)
    if not parser:
        return []
    extractor = EXTRACTORS.get(lang)
    if not extractor:
        return []
    try:
        tree = parser.parse(content.encode("utf-8"))
        if not tree or not tree.root_node:
            return []
        return extractor(content.encode("utf-8"), tree, path)
    except Exception as e:
        logger.debug("Parse %s failed: %s", path, e)
        return []


def parse_files(
    files: list[tuple[str, str]],
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> list[dict[str, Any]]:
    """批量解析，返回所有函数级 chunk。on_progress(done_count, total) 周期性回调（与 GIL 让出同频）。"""
    all_chunks: list[dict[str, Any]] = []
    supported = 0
    total = len(files)
    for i, (path, content) in enumerate(files):
        # 解析在后台线程跑，但 Python 层遍历 AST 会长时间占 GIL，阻塞同进程内处理同步 API 的线程
        if i and i % 8 == 0:
            time.sleep(0)
            if on_progress:
                on_progress(i, total)
        chunks = parse_file(path, content)
        if chunks:
            supported += 1
        all_chunks.extend(chunks)
    if on_progress and files:
        time.sleep(0)
        on_progress(total, total)
    if not all_chunks and files:
        # 诊断：TS/TSX 是否拿到 parser（Docker 需重建镜像才会包含 tsx→typescript 回退）
        parser_tsx = _get_parser("tsx")
        parser_ts = _get_parser("typescript")
        logger.info(
            "parse_files: %s files, 0 function chunks。"
            " get_parser 来源=%s；parser_tsx=%s，parser_typescript=%s。"
            " 若来源为空：在同一 venv 执行 pip install -r backend/requirements.txt（需 tree-sitter-language-pack）。"
            " 若来源非空但 Parser 为 None：多为当前平台无可用预编译语言包或加载失败，可将日志级别调到 DEBUG 查看 “No parser for”。",
            len(files),
            _GET_PARSER_MODULE or "(未安装 tree_sitter_language_pack / tree_sitter_languages)",
            "OK" if parser_tsx else "None",
            "OK" if parser_ts else "None",
        )
    return all_chunks
