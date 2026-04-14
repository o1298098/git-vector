import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable, Optional, Any

import git
from app.config import settings
from app.effective_settings import effective_embed_model, effective_wiki_enabled
from app.code_parser import EXT_TO_LANG, parse_files
from app.analyzer import describe_functions_batch
from app.vector_store import (
    _upsert_project_index_in_db,
    get_project_index_meta,
    get_vector_store,
    normalize_index_path,
    stable_vector_id,
)

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


def _repo_cache_dir_name(project_id: str) -> str:
    """与 repos 目录名一致（非字母数字替换为 _）。"""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in project_id)


def _repo_dir(project_id: str) -> Path:
    return settings.repos_path / _repo_cache_dir_name(project_id)


def _dir_byte_size(path: Path) -> int:
    """递归估算目录占用字节数（仅文件；失败忽略）。"""
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for name in files:
                fp = Path(root) / name
                try:
                    total += int(fp.stat().st_size)
                except OSError:
                    continue
    except OSError:
        return total
    return total


def _maybe_prune_repo_cache(*, keep_project_id: str) -> None:
    """
    在 DATA_DIR/repos 下按「目录 mtime 最旧优先」删除其它项目镜像，直到满足：
    - repos_cache_max_gb：总占用不超过该值（仅统计 repos 子目录）
    - repos_cache_max_count：子目录个数不超过该值（含当前项目）
    当前任务对应目录永不删除。若仅当前项目已超过 max_gb，则无法继续释放，会打告警日志。
    """
    max_gb = float(settings.repos_cache_max_gb or 0)
    max_cnt = int(settings.repos_cache_max_count or 0)
    if max_gb <= 0 and max_cnt <= 0:
        return

    root = settings.repos_path
    keep_name = _repo_cache_dir_name(keep_project_id)
    max_bytes = int(max_gb * (1024**3)) if max_gb > 0 else 0

    def list_repo_dirs() -> list[Path]:
        try:
            return sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name)
        except OSError:
            return []

    def total_bytes() -> int:
        return sum(_dir_byte_size(p) for p in list_repo_dirs())

    def count_dirs() -> int:
        return len(list_repo_dirs())

    # 候选：除当前项目外的子目录，按 mtime 升序（越久未动越先删）
    candidates: list[tuple[Path, float, int]] = []
    for p in list_repo_dirs():
        if p.name == keep_name:
            continue
        try:
            mtime = float(p.stat().st_mtime)
        except OSError:
            mtime = 0.0
        candidates.append((p, mtime, _dir_byte_size(p)))
    candidates.sort(key=lambda x: x[1])

    while True:
        tot = total_bytes()
        cnt = count_dirs()
        over_bytes = max_bytes > 0 and tot > max_bytes
        over_cnt = max_cnt > 0 and cnt > max_cnt
        if not over_bytes and not over_cnt:
            break
        if not candidates:
            if over_bytes:
                logger.warning(
                    "Repo cache over limit (%.2f GiB) but only keep-dir remains for project %s; "
                    "raise REPOS_CACHE_MAX_GB or remove DATA_DIR/repos manually.",
                    tot / (1024**3),
                    keep_project_id,
                )
            break
        victim, _mt, sz = candidates.pop(0)
        try:
            shutil.rmtree(victim, ignore_errors=True)
            logger.info(
                "Pruned repo cache: removed %s (~%s MiB) for disk limits (total was ~%.2f GiB, dirs=%s)",
                victim.name,
                max(1, sz // (1024 * 1024)),
                tot / (1024**3),
                cnt,
            )
        except Exception as e:  # noqa: S110
            logger.warning("Repo cache prune failed for %s: %s", victim, e)
            break


def _should_skip(name: str) -> bool:
    if name in SKIP_PATTERNS or name.startswith("."):
        return True
    for p in SKIP_PATTERNS:
        if p.startswith("*") and name.endswith(p[1:]):
            return True
    return False


def clone_or_pull(repo_url: str, project_id: str) -> Path:
    dest = _repo_dir(project_id)
    _maybe_prune_repo_cache(keep_project_id=project_id)
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


def _git_rev_parse(repo_path: Path) -> Optional[str]:
    try:
        r = subprocess.run(
            ["git", "-C", str(repo_path), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if r.returncode != 0:
            return None
        s = (r.stdout or "").strip()
        return s or None
    except Exception as e:  # noqa: S110
        logger.warning("git rev-parse failed for %s: %s", repo_path, e)
        return None


def _git_diff_name_only(repo_path: Path, old_commit: str, new_commit: str) -> Optional[list[str]]:
    oc = (old_commit or "").strip()
    nc = (new_commit or "").strip()
    if not oc or not nc:
        return None
    try:
        r = subprocess.run(
            ["git", "-C", str(repo_path), "diff", "--name-only", f"{oc}..{nc}"],
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        if r.returncode != 0:
            logger.warning(
                "git diff --name-only failed for %s: %s",
                repo_path,
                (r.stderr or r.stdout or "")[:800],
            )
            return None
        return [normalize_index_path(ln) for ln in (r.stdout or "").splitlines() if ln.strip()]
    except Exception as e:  # noqa: S110
        logger.warning("git diff --name-only error for %s: %s", repo_path, e)
        return None


def _chunks_to_embedding_docs(project_id: str, chunks: list[dict]) -> list[dict]:
    """将已含 description 的 chunk 转为向量库格式（不再重复调用 LLM）。"""
    out = []
    for c in chunks:
        path = c["path"]
        name = c["name"]
        code = c.get("code", "")
        desc = c.get("description", "")
        raw_calls = c.get("calls") or []
        calls = list(dict.fromkeys(str(x) for x in raw_calls if str(x).strip()))
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
        head = _git_rev_parse(repo_path) or ""
        force_full = os.environ.get("FORCE_FULL_INDEX", "").strip().lower() in ("1", "true", "yes", "on")
        use_incremental = bool(settings.incremental_index) and not force_full and bool(head)
        meta_row = get_project_index_meta(project_id)
        last_commit = (meta_row or {}).get("last_indexed_commit") or ""
        last_model = (meta_row or {}).get("last_embed_model") or ""
        embed_model = effective_embed_model()

        if use_incremental and last_commit and head == last_commit and last_model == embed_model:
            logger.info("Index unchanged (HEAD and embed model match last index) for %s", project_id)
            _report("done", percent=100, status="skipped", reason="unchanged", head=head)
            return

        if use_incremental and last_commit:
            _probe_store = get_vector_store()
            if _probe_store.project_has_legacy_vector_ids(project_id):
                logger.info("Legacy vector ids for %s — forcing full reindex", project_id)
                use_incremental = False

        if use_incremental and last_model and last_model != embed_model:
            logger.info("Embed model changed (%s -> %s) for %s — forcing full reindex", last_model, embed_model, project_id)
            use_incremental = False

        paths_delta: set[str] = set()
        if use_incremental and last_commit:
            diff_list = _git_diff_name_only(repo_path, last_commit, head)
            if diff_list is None:
                logger.warning("Git diff failed for %s — forcing full reindex", project_id)
                use_incremental = False
            else:
                paths_delta = set(diff_list)
                if not paths_delta and last_commit != head:
                    logger.warning("Empty diff but commits differ for %s — forcing full reindex", project_id)
                    use_incremental = False

        if use_incremental and not last_commit:
            use_incremental = False

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
        chunk_paths = {normalize_index_path(str(c.get("path") or "")) for c in function_chunks}
        paths_refresh = {p for p in paths_delta if p in chunk_paths} if (use_incremental and paths_delta) else set()

        if use_incremental and paths_delta:
            if paths_refresh:
                idxs: list[int] = []
                sub_chunks: list[dict] = []
                for i, c in enumerate(function_chunks):
                    p = normalize_index_path(str(c.get("path") or ""))
                    if p in paths_refresh:
                        idxs.append(i)
                        sub_chunks.append(c)
                _report("describe_chunks", percent=55, chunk_count=len(sub_chunks), mode="incremental")
                logger.info(
                    "Incremental LLM describe for %s: files_changed=%s, chunks_described=%s",
                    project_id,
                    len(paths_refresh),
                    len(sub_chunks),
                )
                if sub_chunks:
                    described_sub = describe_functions_batch(sub_chunks)
                    for pos, dc in zip(idxs, described_sub):
                        function_chunks[pos] = dc
            else:
                logger.info(
                    "Incremental LLM describe skipped for %s: no changed code chunks matched delta paths=%s",
                    project_id,
                    len(paths_delta),
                )

            # Wiki 依赖 chunk.description；未改动文件从历史向量回填，避免被占位文案覆盖。
            restored_desc = 0
            try:
                old_desc_map = get_vector_store().get_project_llm_descriptions(project_id)
            except Exception as e:  # noqa: S110
                logger.warning("Load historical LLM descriptions failed for %s: %s", project_id, e)
                old_desc_map = {}
            if old_desc_map:
                for c in function_chunks:
                    p = normalize_index_path(str(c.get("path") or ""))
                    if p in paths_refresh:
                        continue
                    if str(c.get("description") or "").strip():
                        continue
                    meta_k = {
                        "path": p,
                        "name": str(c.get("name") or ""),
                        "kind": str(c.get("kind") or ""),
                        "start_line": c.get("start_line"),
                        "end_line": c.get("end_line"),
                    }
                    old_desc = (old_desc_map.get(stable_vector_id(project_id, meta_k)) or "").strip()
                    if not old_desc:
                        continue
                    c["description"] = old_desc
                    restored_desc += 1
            if restored_desc:
                logger.info(
                    "Incremental LLM backfill for %s: restored_descriptions=%s",
                    project_id,
                    restored_desc,
                )
        else:
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
            prev = get_project_index_meta(project_id) or {}
            dc = int(prev.get("doc_count") or 0)
            _upsert_project_index_in_db(
                project_id,
                dc,
                project_name,
                last_indexed_commit=head,
                last_embed_model=embed_model,
            )
            _report("done", percent=100, status="done", skipped_vector_store=True, doc_count=len(docs))
            return
        _report("upsert_vector_store", percent=80, doc_count=len(docs))
        store = get_vector_store()
        if use_incremental and last_commit and paths_delta:
            store.delete_vectors_for_paths(project_id, paths_delta)
            sub_docs = [
                d
                for d in docs
                if normalize_index_path(str((d.get("metadata") or {}).get("path") or "")) in paths_refresh
            ]
            if sub_docs:
                upsert_result = store.upsert_project_incremental(
                    project_id,
                    sub_docs,
                    project_name=project_name,
                    last_indexed_commit=head,
                    last_embed_model=embed_model,
                )
                if upsert_result.get("status") == "partial":
                    _report(
                        "upsert_vector_store",
                        percent=92,
                        mode="incremental",
                        status="partial",
                        embedded=upsert_result.get("embedded"),
                        attempted=upsert_result.get("attempted"),
                    )
            else:
                dc = store.count_project_documents(project_id)
                _upsert_project_index_in_db(
                    project_id,
                    dc,
                    project_name,
                    last_indexed_commit=head,
                    last_embed_model=embed_model,
                )
            logger.info(
                "Incrementally indexed project %s (delta paths=%s, upserted_docs=%s)",
                project_id,
                len(paths_delta),
                len(sub_docs),
            )
        else:
            upsert_result = store.upsert_project(
                project_id,
                docs,
                project_name=project_name,
                last_indexed_commit=head,
                last_embed_model=embed_model,
            )
            if upsert_result.get("status") == "partial":
                _report(
                    "upsert_vector_store",
                    percent=92,
                    mode="full",
                    status="partial",
                    embedded=upsert_result.get("embedded"),
                    attempted=upsert_result.get("attempted"),
                )
            logger.info("Indexed project %s with %s chunks (full)", project_id, len(docs))
        final_meta = get_project_index_meta(project_id) or {}
        final_dc = int(final_meta.get("doc_count") or 0)
        _report("done", percent=100, status="done", doc_count=final_dc)
    except Exception as e:
        logger.exception("Index pipeline failed for %s: %s", project_id, e)
        _report("done", percent=100, status="failed", error=str(e))
        raise
