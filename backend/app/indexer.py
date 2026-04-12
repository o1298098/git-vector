import logging
import os
import shutil
import time
from pathlib import Path
from typing import Callable, Optional, Any

import git
from app.config import settings
from app.effective_settings import effective_wiki_enabled
from app.code_parser import EXT_TO_LANG, parse_files
from app.analyzer import describe_functions_batch
from app.vector_store import get_vector_store

logger = logging.getLogger(__name__)

# 克隆时忽略的大目录/文件，减少体积
SKIP_PATTERNS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "vendor",
    ".idea",
    ".vscode",
    "*.pyc",
    ".env",
    ".env.*",
}


def _repo_dir(project_id: str) -> Path:
    safe_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in project_id)
    return settings.repos_path / safe_id


def _should_skip(name: str) -> bool:
    if name in SKIP_PATTERNS or name.startswith("."):
        return True
    for p in SKIP_PATTERNS:
        if p.startswith("*") and name.endswith(p[1:]):
            return True
    return False


def clone_or_pull(repo_url: str, project_id: str) -> Path:
    dest = _repo_dir(project_id)
    # repo_url 可能是干净 URL，这里按需注入 token
    try:
        from app.job_queue import build_repo_url_for_clone

        auth_url = build_repo_url_for_clone(repo_url)
    except Exception:
        auth_url = repo_url
    if dest.exists():
        try:
            r = git.Repo(dest)
            # 确保 remote 使用最新 token（避免之前 clone 时的 token 失效）
            try:
                r.remotes.origin.set_url(auth_url)
            except Exception:
                pass
            r.remotes.origin.fetch()
            r.git.reset("--hard", "origin/HEAD")
            r.git.clean("-fdx")
            logger.info("Pulled repo %s", project_id)
            return dest
        except Exception as e:
            logger.warning("Pull failed, re-cloning: %s", e)
            shutil.rmtree(dest, ignore_errors=True)
    git.Repo.clone_from(auth_url, dest, depth=1)
    logger.info("Cloned repo %s", project_id)
    return dest


def collect_code_files(repo_path: Path) -> list[tuple[str, str]]:
    """返回 [(相对路径, 文件内容), ...]，仅常见代码/配置。"""
    out = []
    for root, dirs, files in os.walk(repo_path):
        dirs[:] = [d for d in dirs if not _should_skip(d)]
        rel_root = Path(root).relative_to(repo_path)
        for f in files:
            if _should_skip(f):
                continue
            path = rel_root / f
            ext = path.suffix.lower()
            if ext not in {
                ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".go", ".rs", ".cs",
                ".rb", ".php", ".vue", ".sql", ".sh", ".yaml", ".yml", ".json",
                ".md", ".txt", ".html", ".css", ".scss", ".c", ".cpp", ".h",
            } and path.name not in ("Dockerfile", "Makefile", "Dockerfile.*"):
                continue
            full = repo_path / path
            try:
                raw = full.read_bytes()
                try:
                    text = raw.decode("utf-8", errors="replace")
                except Exception:
                    continue
                if len(text) > 500_000:
                    text = text[:500_000] + "\n... [truncated]"
                out.append((str(path), text))
                if len(out) % 50 == 0:
                    time.sleep(0)
            except Exception as e:
                logger.debug("Skip file %s: %s", path, e)
    return out


# 文件扩展名 → Markdown 围栏语言（与前端 highlight.js 常见 id 对齐）
_EXTRA_FENCE_LANG: dict[str, str] = {
    ".sql": "sql",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
    ".md": "markdown",
    ".html": "xml",
    ".txt": "plaintext",
    ".css": "css",
    ".scss": "scss",
    ".php": "php",
}

# tree-sitter 语言名 → 高亮常用 id
_PARSER_LANG_TO_FENCE: dict[str, str] = {
    "tsx": "typescript",
    "vue": "typescript",
}


def _fence_lang_for_path(path: str) -> str:
    """根据路径推断围栏语言标识，便于前端语法高亮。"""
    p = Path(path)
    ext = p.suffix.lower()
    name = p.name
    if name == "Makefile" or name.endswith(".mk"):
        return "makefile"
    if name == "Dockerfile" or name.startswith("Dockerfile."):
        return "dockerfile"
    if ext in _EXTRA_FENCE_LANG:
        return _EXTRA_FENCE_LANG[ext]
    pl = EXT_TO_LANG.get(ext)
    if pl:
        return _PARSER_LANG_TO_FENCE.get(pl, pl)
    return "plaintext"


def _fenced_code_block(code: str, path: str) -> tuple[str, str | None]:
    """
    将代码段包成 Markdown 围栏；返回 (追加到正文的片段, 语言或 None)。
    空代码返回 ("", None)。
    """
    raw = (code or "").strip()
    if not raw:
        return "", None
    lang = _fence_lang_for_path(path)
    return (f"\n```{lang}\n{code.rstrip()}\n```", lang)


def _chunks_to_embedding_docs(project_id: str, chunks: list[dict]) -> list[dict]:
    """将已含 description 的 chunk 转为向量库格式（不再重复调用 LLM）。"""
    out = []
    for c in chunks:
        path = c["path"]
        name = c["name"]
        code = c.get("code", "")
        desc = c.get("description", "")
        calls = c.get("calls") or []
        # 用于检索的文本：路径、名称、描述、代码（便于判断功能是否实现）
        content = f"{path} :: {name}"
        if desc:
            content += f"\n{desc}"
        if calls:
            content += "\nCalls: " + ", ".join(str(x) for x in calls)
        fence_suffix, code_lang = _fenced_code_block(code, path)
        content += fence_suffix
        meta = {
            "path": path,
            "name": name,
            "kind": c.get("kind", "function"),
            "start_line": c.get("start_line"),
            "end_line": c.get("end_line"),
            "calls": calls,
        }
        if code_lang is not None:
            meta["code_lang"] = code_lang
        out.append({"content": content, "metadata": meta})
    return out


def _file_fallback_chunks(files: list[tuple[str, str]], max_files: int = 500) -> list[dict]:
    """当函数级解析得到 0 条时，按文件生成简单 chunk，保证有内容可检索。"""
    code_exts = set(EXT_TO_LANG.keys()) | {".tsx"}
    out = []
    for path, content in files[:max_files]:
        ext = (path.rsplit(".", 1)[-1] if "." in path else "").lower()
        if f".{ext}" in code_exts or path.endswith(".tsx"):
            # 代码文件：取前 8KB 作为内容
            snippet = content[:8192] + ("..." if len(content) > 8192 else "")
        else:
            snippet = content[:4096] + ("..." if len(content) > 4096 else "")
        out.append({
            "path": path,
            "name": path,
            "kind": "file",
            "code": snippet,
            "start_line": 1,
            "end_line": 0,
            "metadata": {"path": path, "name": path, "kind": "file"},
        })
    return out


def run_index_pipeline(
    repo_url: str,
    project_id: str,
    progress: Optional[Callable[[dict[str, Any]], None]] = None,
    project_name: str = "",
) -> None:
    def _report(stage: str, **fields: Any) -> None:
        if not progress:
            return
        try:
            progress({"stage": stage, **fields})
        except Exception:
            # 进度上报失败不影响主流程
            return

    try:
        _report("clone_or_pull", percent=5)
        repo_path = clone_or_pull(repo_url, project_id)
        _report("collect_files", percent=15)
        files = collect_code_files(repo_path)
        if not files:
            logger.warning("No code files found for %s", project_id)
            _report("done", percent=100, status="skipped", reason="no_files")
            return
        # 统计扩展名，便于排查
        exts: dict[str, int] = {}
        for path, _ in files:
            ext = (path.rsplit(".", 1)[-1] if "." in path else "no_ext")
            exts[ext] = exts.get(ext, 0) + 1
        logger.info("Collected %s files for %s (extensions: %s)", len(files), project_id, exts)
        nfiles = len(files)

        def _parse_progress(done: int, total: int) -> None:
            pct = min(15 + int(20 * done / max(total, 1)), 35)
            _report("parse_functions", percent=pct, file_count=total, parsed=done)

        _parse_progress(0, nfiles)
        function_chunks = parse_files(files, on_progress=_parse_progress)
        if not function_chunks:
            logger.warning(
                "No function-level chunks parsed for %s (collected %s files); using file-level fallback",
                project_id, len(files),
            )
            function_chunks = _file_fallback_chunks(files)
        if not function_chunks:
            _report("done", percent=100, status="skipped", reason="no_chunks")
            return
        _report("describe_chunks", percent=55, chunk_count=len(function_chunks))
        function_chunks = describe_functions_batch(function_chunks)

        skip_wiki = os.environ.get("SKIP_WIKI", "").strip().lower() in ("1", "true", "yes")
        if effective_wiki_enabled() and not skip_wiki:
            _report("generate_wiki", percent=62, chunk_count=len(function_chunks))
            try:
                from app.wiki_generator import generate_project_wiki

                wiki_info = generate_project_wiki(
                    project_id,
                    repo_path,
                    function_chunks,
                    files,
                    project_name=project_name,
                )
                logger.info("Wiki: %s", wiki_info.get("browse_url_path") or wiki_info)
            except Exception as wiki_exc:
                logger.warning("Wiki 生成失败（不影响向量索引）: %s", wiki_exc, exc_info=True)

        docs = _chunks_to_embedding_docs(project_id, function_chunks)
        if os.environ.get("SKIP_VECTOR_STORE") == "1":
            logger.info("Indexed project %s with %s chunks (SKIP_VECTOR_STORE=1, skip upsert)", project_id, len(docs))
            _report("done", percent=100, status="done", skipped_vector_store=True, doc_count=len(docs))
            return
        _report("upsert_vector_store", percent=80, doc_count=len(docs))
        store = get_vector_store()
        store.upsert_project(project_id, docs, project_name=project_name)
        logger.info("Indexed project %s with %s chunks", project_id, len(docs))
        _report("done", percent=100, status="done", doc_count=len(docs))
    except Exception as e:
        logger.exception("Index pipeline failed for %s: %s", project_id, e)
        _report("done", percent=100, status="failed", error=str(e))
        raise
