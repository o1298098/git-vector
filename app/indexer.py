import logging
import os
import shutil
from pathlib import Path

import git
from app.config import settings
from app.code_parser import parse_files
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
    if dest.exists():
        try:
            r = git.Repo(dest)
            r.remotes.origin.fetch()
            r.git.reset("--hard", "origin/HEAD")
            r.git.clean("-fdx")
            logger.info("Pulled repo %s", project_id)
            return dest
        except Exception as e:
            logger.warning("Pull failed, re-cloning: %s", e)
            shutil.rmtree(dest, ignore_errors=True)
    git.Repo.clone_from(repo_url, dest, depth=1)
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
            except Exception as e:
                logger.debug("Skip file %s: %s", path, e)
    return out


def _function_chunks_to_docs(project_id: str, chunks: list[dict]) -> list[dict]:
    """将函数级 chunk 转为向量库所需格式：content（用于 embedding）+ metadata。"""
    # 可选：批量 LLM 生成一行描述，便于检索
    chunks = describe_functions_batch(chunks)
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
        content += f"\n{code}"
        meta = {
            "path": path,
            "name": name,
            "kind": c.get("kind", "function"),
            "start_line": c.get("start_line"),
            "end_line": c.get("end_line"),
            "calls": calls,
        }
        out.append({"content": content, "metadata": meta})
    return out


def _file_fallback_chunks(files: list[tuple[str, str]], max_files: int = 500) -> list[dict]:
    """当函数级解析得到 0 条时，按文件生成简单 chunk，保证有内容可检索。"""
    from app.code_parser import EXT_TO_LANG
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


def run_index_pipeline(repo_url: str, project_id: str) -> None:
    try:
        repo_path = clone_or_pull(repo_url, project_id)
        files = collect_code_files(repo_path)
        if not files:
            logger.warning("No code files found for %s", project_id)
            return
        # 统计扩展名，便于排查
        exts: dict[str, int] = {}
        for path, _ in files:
            ext = (path.rsplit(".", 1)[-1] if "." in path else "no_ext")
            exts[ext] = exts.get(ext, 0) + 1
        logger.info("Collected %s files for %s (extensions: %s)", len(files), project_id, exts)
        # Tree-sitter 函数级解析
        function_chunks = parse_files(files)
        if not function_chunks:
            logger.warning(
                "No function-level chunks parsed for %s (collected %s files); using file-level fallback",
                project_id, len(files),
            )
            function_chunks = _file_fallback_chunks(files)
        if not function_chunks:
            return
        docs = _function_chunks_to_docs(project_id, function_chunks)
        if os.environ.get("SKIP_VECTOR_STORE") == "1":
            logger.info("Indexed project %s with %s chunks (SKIP_VECTOR_STORE=1, skip upsert)", project_id, len(docs))
            return
        store = get_vector_store()
        store.upsert_project(project_id, docs)
        logger.info("Indexed project %s with %s chunks", project_id, len(docs))
    except Exception as e:
        logger.exception("Index pipeline failed for %s: %s", project_id, e)
