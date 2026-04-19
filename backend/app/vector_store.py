from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import socket
import threading
import time
from typing import Any, Callable

# Chroma 0.4.x 使用旧版 PostHog 调用方式 capture(distinct_id, event, properties)，
# 而 posthog 6.x 仅接受 capture(event, **kwargs)。在首次 import chromadb 前做兼容补丁：
# 这里直接把 capture 改成 no-op，彻底关闭埋点，避免 API key 报错。
try:
    import posthog as _ph

    def _capture_noop(*args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        return None

    _ph.capture = _capture_noop
except Exception:  # noqa: S110
    pass

import chromadb
from chromadb.config import Settings as ChromaSettings

from app.api_errors import raise_app_error
from app.config import settings
from app.vector_embeddings import _embed, precheck_embedding_connectivity
from app.vector_project_index_repo import (
    _delete_project_index_row,
    _project_index_row_exists,
    _read_project_index_from_db,
    _replace_project_index_in_db,
    _upsert_project_index_in_db,
    get_project_index_meta,
    resolve_project_display_name_for_enqueue,
    set_project_display_name as repo_set_project_display_name,
)
from app.vector_query_fallback import (
    coerce_embedding_to_float_list,
    keyword_boost_for_hit,
    query_tokens_for_boost,
    vector_score_from_embeddings,
)

logger = logging.getLogger(__name__)
COLLECTION_NAME = "gitlab_code_docs"
_chroma_client: chromadb.PersistentClient | None = None
_chroma_init_lock = threading.Lock()

# 旧版向量 id：`{project_id}::{从 0 起的序号}`；新版稳定 id：`gv2_` + sha256 十六进制
_LEGACY_VECTOR_ID = re.compile(r"^.*::\d+$")


def _chroma_reload_marker_path() -> str:
    return str(settings.chroma_path / ".chroma_reload_marker")


def _read_chroma_reload_marker_mtime() -> float:
    marker = _chroma_reload_marker_path()
    try:
        return float(os.path.getmtime(marker))
    except OSError:
        return 0.0


def _touch_chroma_reload_marker() -> None:
    try:
        settings.chroma_path.mkdir(parents=True, exist_ok=True)
        marker = _chroma_reload_marker_path()
        with open(marker, "a", encoding="utf-8"):
            pass
        os.utime(marker, None)
    except Exception as e:  # noqa: S110
        logger.warning("Failed to touch chroma reload marker: %s", e)


def normalize_index_path(path: str) -> str:
    """与 chunk path / git diff 路径对齐（正斜杠、去首尾空白）。"""
    return str(path or "").strip().replace("\\", "/")


def stable_vector_id(project_id: str, meta: dict[str, Any]) -> str:
    """
    跨次索引稳定的向量 id，用于增量 upsert / 按路径删除。
    勿改拼接规则，否则已入库 id 全部失效需全量重建。
    """
    pid = str(project_id or "").strip()
    path = normalize_index_path(str(meta.get("path") or ""))
    name = str(meta.get("name") or "").strip()
    kind = str(meta.get("kind") or "").strip()
    sl = meta.get("start_line", "")
    el = meta.get("end_line", "")
    raw = f"{pid}\x00{path}\x00{name}\x00{kind}\x00{sl}\x00{el}"
    return "gv2_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def is_legacy_vector_id(vid: str) -> bool:
    s = str(vid or "")
    if s.startswith("gv2_"):
        return False
    return bool(_LEGACY_VECTOR_ID.match(s))


def _dedupe_upsert_rows(
    ids: list[str],
    docs: list[str],
    metas: list[dict[str, Any]],
    embs: list[list[float]],
    *,
    project_id: str,
    mode: str,
) -> tuple[list[str], list[str], list[dict[str, Any]], list[list[float]]]:
    """
    Chroma upsert 要求一次请求内 ids 唯一。
    这里做请求内去重（保留首条），并输出可定位日志。
    """
    seen: set[str] = set()
    keep_idx: list[int] = []
    dup_logs: list[str] = []
    dup_count = 0
    for i, vid in enumerate(ids):
        s = str(vid or "").strip()
        if not s:
            continue
        if s in seen:
            dup_count += 1
            m = metas[i] if i < len(metas) else {}
            dup_logs.append(
                f"{s} path={normalize_index_path(str((m or {}).get('path') or ''))!r} "
                f"name={str((m or {}).get('name') or '')!r} "
                f"kind={str((m or {}).get('kind') or '')!r} "
                f"lines={str((m or {}).get('start_line') or '?')}-{str((m or {}).get('end_line') or '?')}"
            )
            continue
        seen.add(s)
        keep_idx.append(i)

    if dup_count > 0:
        preview = "; ".join(dup_logs[:12])
        logger.warning(
            "Deduplicated %s duplicate vector ids before %s upsert for project %s. examples: %s",
            dup_count,
            mode,
            project_id,
            preview,
        )

    return (
        [ids[i] for i in keep_idx],
        [docs[i] for i in keep_idx],
        [metas[i] for i in keep_idx],
        [embs[i] for i in keep_idx],
    )


def _extract_llm_description_from_document(
    doc: str,
    *,
    path: str,
    name: str,
) -> str:
    """
    从索引时写入的 content 文本中提取一行 LLM 描述。
    content 形态约定（见 indexer._chunks_to_embedding_docs）：
      1) "<path> :: <name>"
      2) "<description>"（可选）
      3) "Calls: ..."（可选）
      4) ```... 代码块（可选）
    """
    text = str(doc or "")
    if not text.strip():
        return ""
    tagged = _parse_tagged_document(text)
    summary = str(
        tagged.get("SUMMARY")
        or tagged.get("SUMMARY_ZH")
        or tagged.get("FUNCTIONALITY")
        or ""
    ).strip()
    if summary:
        return summary
    lines = text.splitlines()
    if not lines:
        return ""
    expected_head = f"{normalize_index_path(path)} :: {str(name or '').strip()}"
    if lines and lines[0].strip() != expected_head:
        # 文本格式异常（或被手工改写）时不做激进解析，避免误提取。
        return ""
    for ln in lines[1:]:
        s = (ln or "").strip()
        if not s:
            continue
        if s.startswith("Calls:") or s.startswith("[") or s.startswith("```"):
            return ""
        return s
    return ""


def _parse_tagged_document(doc: str) -> dict[str, str]:
    """
    解析形如 `[KEY] value` 的弱结构化 DSL 文本。
    仅提取第一层标签行，不解析 JSON/嵌套结构。
    """
    out: dict[str, str] = {}
    for ln in str(doc or "").splitlines():
        s = ln.strip()
        if not s.startswith("["):
            continue
        end = s.find("]")
        if end <= 1:
            continue
        key = s[1:end].strip().upper()
        val = s[end + 1 :].strip()
        if not key or not val:
            continue
        out[key] = val
    return out


def _scan_all_project_docs_from_vector_store(collection: Any) -> dict[str, int]:
    """
    仅用于首次回填 project_index 缓存（或缓存为空时）。

    说明：Chroma 的 get 是否支持 offset 取决于版本；这里做了兼容。
    """
    batch_size = int(os.getenv("PROJECT_LIST_SCAN_BATCH_SIZE", "2000"))
    max_limit = int(os.getenv("PROJECT_LIST_MAX_DOCS", "50000"))  # 旧行为兜底
    backfill_max_docs = int(os.getenv("PROJECT_LIST_BACKFILL_MAX_DOCS", "0"))  # 0 表示不限制

    project_stats: dict[str, int] = {}
    offset = 0
    scanned = 0

    while True:
        try:
            chunk = collection.get(
                include=["metadatas"],
                limit=batch_size,
                offset=offset,
            )
        except TypeError:
            # offset 不支持：回退到单次读取（仍可能漏项目，但至少不会直接失效）
            all_docs = collection.get(include=["metadatas"], limit=max_limit)
            metas = all_docs.get("metadatas") or []
            for meta in metas:
                if not meta:
                    continue
                pid = meta.get("project_id")
                if not pid:
                    continue
                project_stats[pid] = project_stats.get(pid, 0) + 1
            logger.warning(
                "Chroma get(offset=...) 不支持，回退到 limit=%s 扫描；/api/projects 仍可能漏项目。",
                max_limit,
            )
            return project_stats

        metas = chunk.get("metadatas") or []
        if not metas:
            break

        for meta in metas:
            if not meta:
                continue
            pid = meta.get("project_id")
            if not pid:
                continue
            project_stats[pid] = project_stats.get(pid, 0) + 1

        scanned += len(metas)
        offset += len(metas)
        if backfill_max_docs > 0 and scanned >= backfill_max_docs:
            logger.warning(
                "Backfill 中止：达到 PROJECT_LIST_BACKFILL_MAX_DOCS=%s（当前扫描=%s）。",
                backfill_max_docs,
                scanned,
            )
            break

    return project_stats


def _get_chroma() -> chromadb.PersistentClient:
    global _chroma_client
    with _chroma_init_lock:
        if _chroma_client is None:
            path = str(settings.chroma_path)
            settings.chroma_path.mkdir(parents=True, exist_ok=True)
            _chroma_client = chromadb.PersistentClient(
                path=path,
                settings=ChromaSettings(anonymized_telemetry=False),
            )
        return _chroma_client


class VectorStore:
    def __init__(self):
        self._chrom_lock = threading.RLock()
        self._reload_marker_mtime = _read_chroma_reload_marker_mtime()
        self.client = _get_chroma()
        self.collection = self.client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"description": "GitLab project code descriptions"},
        )

    def _ensure_fresh_client_by_marker(self) -> None:
        marker_mtime = _read_chroma_reload_marker_mtime()
        if marker_mtime > self._reload_marker_mtime + 1e-6:
            logger.info("Detected external Chroma update marker; recreating client.")
            self._recreate_persistent_chroma_client()
            self._reload_marker_mtime = marker_mtime

    def _recreate_persistent_chroma_client(self) -> None:
        """
        在已持有 ``self._chrom_lock`` 时调用。

        Chroma 0.4.x 在同一 PersistentClient 内对集合做 delete / 大批量 upsert 后，
        内存中的 ANN 索引有时与持久化数据脱节，表现为 ``collection.query`` 长期返回空、
        只能走关键词兜底；重启进程会新建客户端从而恢复。此处等价于「对该单例重新打开库」。
        """
        global _chroma_client
        # 仅重建 PersistentClient 在部分场景不足以清理进程级系统缓存；
        # clear_system_cache() 可强制刷新 Chroma 在当前进程内维护的底层索引状态。
        try:
            from chromadb.api.client import SharedSystemClient

            SharedSystemClient.clear_system_cache()
        except Exception as e:  # noqa: S110
            logger.warning("Failed to clear Chroma shared system cache: %s", e)
        with _chroma_init_lock:
            _chroma_client = None
        self.client = _get_chroma()
        self.collection = self.client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"description": "GitLab project code descriptions"},
        )
        self._reload_marker_mtime = _read_chroma_reload_marker_mtime()

    def list_projects(self) -> list[dict[str, Any]]:
        """
        列出当前向量库中已存在的项目。

        返回结构：
        [
            {"project_id": "my-repo", "doc_count": 123},
            ...
        ]

        说明：
        - 使用 SQLite 缓存表 `project_index`，避免每次都扫描向量库造成漏项目/性能问题。
        - 缓存为空时，才对 Chroma 做一次回填（扫描 metadatas 汇总 project_id -> doc_count）。
        """
        cached = _read_project_index_from_db()
        if cached:
            return cached

        try:
            with self._chrom_lock:
                project_stats = _scan_all_project_docs_from_vector_store(self.collection)
            _replace_project_index_in_db(project_stats)
        except Exception as e:  # noqa: S110
            logger.error("Backfill project_index from vector store failed: %s", e)

        return _read_project_index_from_db()

    def set_project_display_name(self, project_id: str, project_name: str) -> bool:
        """仅更新 project_index 中的展示名，不改变 doc_count；无对应行则返回 False。"""
        return repo_set_project_display_name(project_id, project_name)

    def get_project_index_status(self, project_id: str) -> dict[str, Any]:
        """
        查询指定 project_id 是否已在向量库中建立索引（已成功写入至少一条向量）。

        返回：
        - project_id: 查询用的项目标识（与索引时传入的一致）
        - indexed: 是否已索引
        - doc_count: 该项目下的向量条数（未索引时为 0）
        """
        pid = str(project_id).strip()
        if not pid:
            return {"project_id": project_id, "indexed": False, "doc_count": 0}

        try:
            with self._chrom_lock:
                probe = self.collection.get(
                    where={"project_id": pid},
                    limit=1,
                    include=[],
                )
        except Exception as e:  # noqa: S110
            logger.error("get_project_index_status probe failed for %s: %s", pid, e)
            return {"project_id": pid, "indexed": False, "doc_count": 0}

        ids = probe.get("ids") or []
        if not ids:
            return {"project_id": pid, "indexed": False, "doc_count": 0}

        try:
            with self._chrom_lock:
                full = self.collection.get(where={"project_id": pid}, include=[])
                doc_count = len(full.get("ids") or [])
        except Exception as e:  # noqa: S110
            logger.error("get_project_index_status count failed for %s: %s", pid, e)
            return {"project_id": pid, "indexed": True, "doc_count": 0}

        return {"project_id": pid, "indexed": True, "doc_count": doc_count}

    def purge_project(self, project_id: str) -> dict[str, Any]:
        """
        删除该项目在 Chroma 中的全部向量，并移除 project_index 缓存行。

        返回 removed_docs：删除前统计的条数；had_vectors_or_cache：删除前是否在库中有向量或缓存行。
        """
        pid = str(project_id).strip()
        if not pid:
            raise ValueError("project_id 不能为空")
        had_row = _project_index_row_exists(pid)
        with self._chrom_lock:
            self._ensure_fresh_client_by_marker()
            doc_count = 0
            try:
                full = self.collection.get(where={"project_id": pid}, include=[])
                doc_count = len(full.get("ids") or [])
            except Exception as e:  # noqa: S110
                logger.warning("purge_project: count failed for %s: %s", pid, e)
            try:
                self.collection.delete(where={"project_id": pid})
            except Exception as e:  # noqa: S110
                logger.warning("purge_project: chroma delete failed for %s: %s", pid, e)
            _touch_chroma_reload_marker()
            self._recreate_persistent_chroma_client()
        _delete_project_index_row(pid)
        return {
            "project_id": pid,
            "removed_docs": doc_count,
            "had_vectors_or_cache": doc_count > 0 or had_row,
        }

    def _sanitize_metadata(self, meta: dict[str, Any]) -> dict[str, Any]:
        """
        Chroma 要求 metadata 的 value 必须是 str / int / float / bool。
        这里对其他类型做一次容错转换，避免因为某个字段是 list / dict 等导致整批 upsert 失败。
        """
        out: dict[str, Any] = {}
        for k, v in (meta or {}).items():
            # 丢弃 None，避免不必要的问题
            if v is None:
                continue
            if isinstance(v, (str, int, float, bool)):
                out[k] = v
                continue
            # 其他复杂类型统一转成 JSON 字符串（若失败则用 repr）
            try:
                out[k] = json.dumps(v, ensure_ascii=False)
            except Exception:
                out[k] = repr(v)
        return out

    def project_has_legacy_vector_ids(self, project_id: str) -> bool:
        """是否存在旧版 `{project_id}::序号` 向量 id（与增量模式不兼容，需先全量重建）。"""
        pid = str(project_id or "").strip()
        if not pid:
            return False
        try:
            with self._chrom_lock:
                probe = self.collection.get(where={"project_id": pid}, limit=5, include=[])
                for vid in probe.get("ids") or []:
                    if is_legacy_vector_id(str(vid)):
                        return True
        except Exception as e:  # noqa: S110
            logger.warning("project_has_legacy_vector_ids probe failed for %s: %s", pid, e)
        return False

    def delete_vectors_for_paths(self, project_id: str, paths: set[str]) -> int:
        """
        删除 metadata.path 属于给定集合（规范化后精确匹配）的向量。
        用于增量索引：删文件、或变更文件前先清掉该路径下旧符号行号对应的条目。
        """
        pid = str(project_id or "").strip()
        if not pid or not paths:
            return 0
        want = {normalize_index_path(p) for p in paths if str(p).strip()}
        if not want:
            return 0
        ids_to_del: list[str] = []
        with self._chrom_lock:
            self._ensure_fresh_client_by_marker()
            try:
                chunk = self.collection.get(
                    where={"project_id": pid},
                    include=["metadatas"],
                    limit=100_000,
                )
            except TypeError:
                chunk = self.collection.get(where={"project_id": pid}, include=["metadatas"])
            ids = chunk.get("ids") or []
            metas = chunk.get("metadatas") or []
            for vid, meta in zip(ids, metas):
                p = normalize_index_path(str((meta or {}).get("path") or ""))
                if p in want:
                    ids_to_del.append(str(vid))
            if not ids_to_del:
                return 0
            try:
                self.collection.delete(ids=ids_to_del)
            except Exception as e:  # noqa: S110
                logger.warning("delete_vectors_for_paths delete failed for %s: %s", pid, e)
                return 0
            logger.info("Deleted %s vectors for project %s (path-based incremental)", len(ids_to_del), pid)
            _touch_chroma_reload_marker()
            self._recreate_persistent_chroma_client()
        return len(ids_to_del)

    def count_project_documents(self, project_id: str) -> int:
        pid = str(project_id or "").strip()
        if not pid:
            return 0
        try:
            with self._chrom_lock:
                self._ensure_fresh_client_by_marker()
                full = self.collection.get(where={"project_id": pid}, include=[])
                return len(full.get("ids") or [])
        except Exception as e:  # noqa: S110
            logger.warning("count_project_documents failed for %s: %s", pid, e)
            return 0

    def get_project_llm_descriptions(self, project_id: str) -> dict[str, str]:
        """
        读取项目已有向量中的 LLM 描述，返回 {stable_vector_id: description}。
        用于增量索引时给未改动文件回填 description，避免 Wiki 出现“未生成描述”。
        """
        pid = str(project_id or "").strip()
        if not pid:
            return {}
        out: dict[str, str] = {}
        try:
            with self._chrom_lock:
                self._ensure_fresh_client_by_marker()
                try:
                    rows = self.collection.get(
                        where={"project_id": pid},
                        include=["documents", "metadatas"],
                        limit=100_000,
                    )
                except TypeError:
                    rows = self.collection.get(where={"project_id": pid}, include=["documents", "metadatas"])
        except Exception as e:  # noqa: S110
            logger.warning("get_project_llm_descriptions failed for %s: %s", pid, e)
            return {}

        ids = rows.get("ids") or []
        docs = rows.get("documents") or []
        metas = rows.get("metadatas") or []
        for vid, doc, meta in zip(ids, docs, metas):
            m = meta or {}
            path = normalize_index_path(str(m.get("path") or ""))
            name = str(m.get("name") or "").strip()
            if not path:
                continue
            desc = _extract_llm_description_from_document(str(doc or ""), path=path, name=name).strip()
            if not desc:
                continue
            vid_s = str(vid or "")
            if vid_s.startswith("gv2_"):
                key = vid_s
            else:
                key = stable_vector_id(pid, m)
            out[key] = desc
        return out

    def _prepare_upsert_rows(
        self,
        project_id: str,
        chunks: list[dict[str, Any]],
        *,
        mode: str,
        on_log: Callable[..., None] | None = None,
    ) -> tuple[list[str], list[str], list[dict[str, Any]], list[list[float]]]:
        """准备 upsert 参数并完成 embedding/失败过滤/去重。"""
        documents = [c.get("content", "") for c in chunks]
        embed_inputs = [c.get("embedding_text") or c.get("content", "") for c in chunks]
        raw_metas = [{**c.get("metadata", {}), "project_id": project_id} for c in chunks]
        metadatas = [self._sanitize_metadata(m) for m in raw_metas]
        ids = [stable_vector_id(project_id, m) for m in metadatas]

        if on_log:
            try:
                on_log(
                    "INFO",
                    "upsert_vector_store",
                    f"Embedding start: mode={mode}, chunks={len(chunks)}, inputs={len(embed_inputs)}",
                    source="vector_store",
                )
            except Exception:
                pass
        try:
            emb_with_idx = _embed(embed_inputs, prefix="passage: ")
        except Exception as e:  # noqa: S110
            if mode == "incremental":
                logger.error(
                    "Embedding failed for project %s (incremental), skip upsert: %s",
                    project_id,
                    e,
                )
                raise RuntimeError("EMBEDDING_UNAVAILABLE: embedding failed for all chunks (incremental)")
            logger.error(
                "Embedding failed for project %s, skip upsert to vector store: %s",
                project_id,
                e,
            )
            raise RuntimeError("EMBEDDING_UNAVAILABLE: embedding failed for all chunks")

        if on_log:
            try:
                on_log(
                    "INFO",
                    "upsert_vector_store",
                    f"Embedding done: mode={mode}, succeeded={len(emb_with_idx)}, attempted={len(embed_inputs)}",
                    source="vector_store",
                )
            except Exception:
                pass
        idx_to_emb: dict[int, list[float]] = {idx: emb for idx, emb in emb_with_idx}
        kept_ids: list[str] = []
        kept_docs: list[str] = []
        kept_metas: list[dict[str, Any]] = []
        kept_embs: list[list[float]] = []

        for i, (id_, doc, meta) in enumerate(zip(ids, documents, metadatas)):
            emb = idx_to_emb.get(i)
            if emb is None:
                if mode == "incremental":
                    logger.warning(
                        "Skip incremental upsert for project %s, chunk index %s due to embedding failure.",
                        project_id,
                        i,
                    )
                else:
                    logger.warning(
                        "Skip upsert for project %s, chunk index %s due to embedding failure.",
                        project_id,
                        i,
                    )
                continue
            kept_ids.append(id_)
            kept_docs.append(doc)
            kept_metas.append(meta)
            kept_embs.append(emb)

        if not kept_ids:
            if mode == "incremental":
                logger.error("No successful embeddings for project %s (incremental), skip upsert.", project_id)
                raise RuntimeError("EMBEDDING_UNAVAILABLE: no successful embeddings for incremental upsert")
            logger.error(
                "No successful embeddings for project %s, skip upsert to vector store.",
                project_id,
            )
            raise RuntimeError("EMBEDDING_UNAVAILABLE: no successful embeddings for full upsert")

        kept_ids, kept_docs, kept_metas, kept_embs = _dedupe_upsert_rows(
            kept_ids,
            kept_docs,
            kept_metas,
            kept_embs,
            project_id=project_id,
            mode=mode,
        )
        if on_log:
            try:
                on_log(
                    "INFO",
                    "upsert_vector_store",
                    f"Embedding rows prepared: mode={mode}, kept={len(kept_ids)}, attempted={len(chunks)}",
                    source="vector_store",
                )
            except Exception:
                pass
        if not kept_ids:
            if mode == "incremental":
                logger.error(
                    "All successful embeddings were deduplicated away for project %s (incremental), skip upsert.",
                    project_id,
                )
                raise RuntimeError("EMBEDDING_UNAVAILABLE: dedup removed all vectors for incremental upsert")
            logger.error(
                "All successful embeddings were deduplicated away for project %s (full), skip upsert.",
                project_id,
            )
            raise RuntimeError("EMBEDDING_UNAVAILABLE: dedup removed all vectors for full upsert")

        return kept_ids, kept_docs, kept_metas, kept_embs

    def _probe_doc_count_after_upsert(
        self,
        project_id: str,
        *,
        fallback: int,
        mode: str,
    ) -> int:
        """upsert 后探测项目向量数；失败时返回调用方提供的 fallback。"""
        try:
            full = self.collection.get(where={"project_id": project_id}, include=[])
            return len(full.get("ids") or [])
        except Exception as e:  # noqa: S110
            if mode == "incremental":
                logger.warning("Failed to probe doc_count after incremental upsert for %s: %s", project_id, e)
            else:
                logger.warning("Failed to probe doc_count after upsert for %s: %s", project_id, e)
            return fallback

    @staticmethod
    def _build_upsert_result(chunks: list[dict[str, Any]], kept_ids: list[str]) -> dict[str, Any]:
        """构建标准 upsert 返回体。"""
        return {
            "attempted": len(chunks),
            "embedded": len(kept_ids),
            "status": "ok" if len(kept_ids) == len(chunks) else "partial",
        }

    def upsert_project(
        self,
        project_id: str,
        chunks: list[dict[str, Any]],
        *,
        project_name: str = "",
        last_indexed_commit: str = "",
        last_embed_model: str = "",
        on_log: Callable[..., None] | None = None,
    ) -> dict[str, Any]:
        if not chunks:
            return {"attempted": 0, "embedded": 0, "status": "skipped"}
        # 向量化优先使用 embedding_text（不含大段源码）；documents 仍保存完整 content 供展示/二阶段分析。
        kept_ids, kept_docs, kept_metas, kept_embs = self._prepare_upsert_rows(
            project_id,
            chunks,
            mode="full",
            on_log=on_log,
        )

        # 全量：先删该项目全部向量，再写入（稳定 id 与旧 :: 序号 id 不混用）
        with self._chrom_lock:
            self._ensure_fresh_client_by_marker()
            try:
                self.collection.delete(where={"project_id": project_id})
            except Exception as e:  # noqa: S110
                logger.warning("Delete old vectors failed for project %s: %s", project_id, e)

            if on_log:
                try:
                    on_log(
                        "INFO",
                        "upsert_vector_store",
                        f"Vector store full upsert start: rows={len(kept_ids)}",
                        source="vector_store",
                    )
                except Exception:
                    pass
            self.collection.upsert(
                ids=kept_ids,
                embeddings=kept_embs,
                documents=kept_docs,
                metadatas=kept_metas,
            )
            logger.info("Upserted %s chunks for project %s (full)", len(kept_ids), project_id)
            if on_log:
                try:
                    on_log(
                        "INFO",
                        "upsert_vector_store",
                        f"Vector store full upsert done: rows={len(kept_ids)}",
                        source="vector_store",
                    )
                except Exception:
                    pass

            # 探测实际写入数量，写入缓存，避免 delete/upsert 部分失败导致统计不一致。
            doc_count = self._probe_doc_count_after_upsert(
                project_id,
                fallback=len(kept_ids),
                mode="full",
            )
            _upsert_project_index_in_db(
                project_id,
                doc_count,
                project_name,
                last_indexed_commit=last_indexed_commit,
                last_embed_model=last_embed_model,
            )
            _touch_chroma_reload_marker()
            self._recreate_persistent_chroma_client()
        return self._build_upsert_result(chunks, kept_ids)

    def upsert_project_incremental(
        self,
        project_id: str,
        chunks: list[dict[str, Any]],
        *,
        project_name: str = "",
        last_indexed_commit: str = "",
        last_embed_model: str = "",
        on_log: Callable[..., None] | None = None,
    ) -> dict[str, Any]:
        """仅 upsert 给定条目，不删全项目；调用方应先按路径删除待刷新路径上的旧向量。"""
        if not chunks:
            return {"attempted": 0, "embedded": 0, "status": "skipped"}
        kept_ids, kept_docs, kept_metas, kept_embs = self._prepare_upsert_rows(
            project_id,
            chunks,
            mode="incremental",
            on_log=on_log,
        )

        with self._chrom_lock:
            self._ensure_fresh_client_by_marker()
            if on_log:
                try:
                    on_log(
                        "INFO",
                        "upsert_vector_store",
                        f"Vector store incremental upsert start: rows={len(kept_ids)}",
                        source="vector_store",
                    )
                except Exception:
                    pass
            self.collection.upsert(
                ids=kept_ids,
                embeddings=kept_embs,
                documents=kept_docs,
                metadatas=kept_metas,
            )
            logger.info("Incrementally upserted %s chunks for project %s", len(kept_ids), project_id)
            if on_log:
                try:
                    on_log(
                        "INFO",
                        "upsert_vector_store",
                        f"Vector store incremental upsert done: rows={len(kept_ids)}",
                        source="vector_store",
                    )
                except Exception:
                    pass

            doc_count = self._probe_doc_count_after_upsert(
                project_id,
                fallback=0,
                mode="incremental",
            )
            _upsert_project_index_in_db(
                project_id,
                doc_count,
                project_name,
                last_indexed_commit=last_indexed_commit,
                last_embed_model=last_embed_model,
            )
            _touch_chroma_reload_marker()
            self._recreate_persistent_chroma_client()
        return self._build_upsert_result(chunks, kept_ids)

    def _query_chroma_locked(
        self,
        query_emb: list[float],
        text: str,
        project_id: str | None,
        top_k: int,
    ) -> list[dict[str, Any]]:
        """在已持有 ``_chrom_lock`` 的前提下执行 Chroma query / 兜底扫描。"""
        emb = [query_emb]
        where = {"project_id": project_id} if project_id else None
        results = self.collection.query(
            query_embeddings=emb,
            n_results=top_k,
            where=where,
            include=["documents", "metadatas", "distances"],
        )
        out: list[dict[str, Any]] = []
        tokens = query_tokens_for_boost(text)
        docs = (results.get("documents") or [[]])[0]
        metas = (results.get("metadatas") or [[]])[0]
        dists = (results.get("distances") or [[]])[0]
        n = min(len(docs), len(metas))
        if n == 0 and project_id:
            logger.warning(
                "Primary vector query returned empty. host=%s pid=%s project=%s top_k=%s q_len=%s chroma_path=%s",
                socket.gethostname(),
                os.getpid(),
                project_id,
                top_k,
                len(query_emb),
                str(settings.chroma_path),
            )
        for i in range(n):
            d = docs[i]
            m = metas[i]
            dist = dists[i] if i < len(dists) else None
            try:
                dist_f = float(dist) if dist is not None else None
            except (TypeError, ValueError):
                dist_f = None
            # Chroma 返回的是距离（越小越近）；API 同时给出 score 供前端展示「相似度」：越大越相关
            score = (1.0 / (1.0 + dist_f)) if dist_f is not None else None
            meta = m or {}
            boost = keyword_boost_for_hit(tokens, str(d or ""), meta)
            base = float(score) if score is not None else 0.0
            hybrid = min(1.0, base + boost)
            out.append(
                {
                    "content": d,
                    "metadata": meta,
                    "distance": dist_f,
                    "score": score,
                    "boost": boost,
                    "hybrid_score": hybrid,
                }
            )
        out.sort(key=lambda x: float(x.get("hybrid_score") or 0.0), reverse=True)
        if out:
            return out

        # 兜底：部分历史数据可能存在“有 documents/metadatas，但向量索引不可检索”的状态。
        # 当语义 query 返回空时，退化到项目内文档检索，避免接口全空。
        if project_id:
            pid = str(project_id).strip()
            if pid:
                try:
                    # 回退时尽量多取一些样本，优先用已存 embedding 计算相似度分数；
                    # 若历史条目缺失 embedding，再退化为纯关键词分。
                    fallback_scan_limit = max(int(top_k), int(os.getenv("QUERY_FALLBACK_SCAN_LIMIT", "2000")))
                    raw = self.collection.get(
                        where={"project_id": pid},
                        include=["documents", "metadatas", "embeddings"],
                        limit=max(1, fallback_scan_limit),
                    )
                    r_docs = raw.get("documents") or []
                    r_metas = raw.get("metadatas") or []
                    r_embs = raw.get("embeddings") or []
                    fb: list[dict[str, Any]] = []
                    has_embedding_signal = False
                    has_keyword_signal = False
                    emb_missing = 0
                    emb_dim_mismatch = 0
                    emb_usable = 0
                    q_len = len(query_emb)
                    for i, (d, m) in enumerate(zip(r_docs, r_metas)):
                        e = r_embs[i] if i < len(r_embs) else None
                        meta = m or {}
                        hit_vec = coerce_embedding_to_float_list(e)
                        if hit_vec is None:
                            emb_missing += 1
                        elif len(hit_vec) != q_len:
                            emb_dim_mismatch += 1
                        else:
                            emb_usable += 1
                        score, dist = vector_score_from_embeddings(query_emb, hit_vec)
                        boost = keyword_boost_for_hit(tokens, str(d or ""), meta)
                        if score is None:
                            # 历史文档可能没有 embedding；此时至少给出可比较的关键词分。
                            score = boost
                            dist = None
                            fallback_source = "collection_get_lexical"
                        else:
                            has_embedding_signal = True
                            fallback_source = "collection_get_embeddings"
                        if boost > 0:
                            has_keyword_signal = True
                        fb.append(
                            {
                                "content": d,
                                "metadata": meta,
                                "distance": dist,
                                "score": score,
                                "boost": boost,
                                "hybrid_score": min(1.0, float(score) + boost),
                                "fallback_source": fallback_source,
                            }
                        )
                    if fb and not has_embedding_signal and not has_keyword_signal:
                        # 第一批样本未命中时，继续做一次分页关键词兜底扫描：
                        # 避免因 limit 截断导致“明明有关键词却返回空”。
                        lexical_hits: list[dict[str, Any]] = []
                        lex_batch = max(200, int(os.getenv("QUERY_FALLBACK_LEXICAL_BATCH", "1000")))
                        lex_max = max(lex_batch, int(os.getenv("QUERY_FALLBACK_LEXICAL_MAX_DOCS", "20000")))
                        scanned = 0
                        offset = 0
                        while scanned < lex_max:
                            remain = lex_max - scanned
                            this_limit = min(lex_batch, remain)
                            try:
                                chunk = self.collection.get(
                                    where={"project_id": pid},
                                    include=["documents", "metadatas"],
                                    limit=this_limit,
                                    offset=offset,
                                )
                            except TypeError:
                                # 旧版本不支持 offset，退化为单次读取并中止循环。
                                chunk = self.collection.get(
                                    where={"project_id": pid},
                                    include=["documents", "metadatas"],
                                    limit=lex_max,
                                )
                                scanned = lex_max
                            docs2 = chunk.get("documents") or []
                            metas2 = chunk.get("metadatas") or []
                            if not docs2:
                                break
                            for d2, m2 in zip(docs2, metas2):
                                meta2 = m2 or {}
                                boost2 = keyword_boost_for_hit(tokens, str(d2 or ""), meta2)
                                if boost2 <= 0:
                                    continue
                                lexical_hits.append(
                                    {
                                        "content": d2,
                                        "metadata": meta2,
                                        "distance": None,
                                        "score": boost2,
                                        "boost": boost2,
                                        "hybrid_score": boost2,
                                        "fallback_source": "collection_get_lexical_scan",
                                    }
                                )
                            got = len(docs2)
                            scanned += got
                            offset += got
                            if got < this_limit:
                                break
                            if lexical_hits and len(lexical_hits) >= max(1, int(top_k)):
                                break
                        if lexical_hits:
                            lexical_hits.sort(key=lambda x: float(x.get("hybrid_score") or 0.0), reverse=True)
                            return lexical_hits[: max(1, int(top_k))]
                        logger.warning(
                            "Query fallback has no retrieval signal for %s after lexical scan; "
                            "returning empty results (initial_docs=%s, scanned=%s, top_k=%s).",
                            pid,
                            len(fb),
                            scanned,
                            top_k,
                        )
                        return []
                    if fb and not has_embedding_signal:
                        logger.warning(
                            "Fallback has no embedding signal. host=%s pid=%s project=%s docs=%s emb_usable=%s emb_missing=%s emb_dim_mismatch=%s q_len=%s",
                            socket.gethostname(),
                            os.getpid(),
                            pid,
                            len(fb),
                            emb_usable,
                            emb_missing,
                            emb_dim_mismatch,
                            q_len,
                        )
                    fb.sort(key=lambda x: float(x.get("hybrid_score") or 0.0), reverse=True)
                    if fb:
                        return fb[: max(1, int(top_k))]
                except Exception as e:  # noqa: S110
                    logger.warning("Query fallback get() failed for %s: %s", pid, e)
        return out

    def query(
        self,
        text: str,
        project_id: str | None = None,
        top_k: int = 10,
    ) -> list[dict[str, Any]]:
        # 查询时加 query 前缀；embedding 故障必须显式返回错误，避免“无结果”假象。
        try:
            emb_with_idx = _embed([text], prefix="query: ")
        except Exception as e:  # noqa: S110
            logger.error("Embedding failed for query %r: %s", text[:200], e)
            raise_app_error(
                status_code=503,
                code="EMBEDDING_UNAVAILABLE",
                message="向量检索暂时不可用",
                hint="请稍后重试，或检查 Embedding 服务状态与模型配置。",
                retryable=True,
            )
        if not emb_with_idx:
            logger.error("Embedding returned empty list for query %r", text[:200])
            raise_app_error(
                status_code=503,
                code="EMBEDDING_UNAVAILABLE",
                message="向量检索暂时不可用",
                hint="Embedding 服务未返回有效向量，请稍后重试。",
                retryable=True,
            )
        # 只有一条 query 文本，这里取第一条成功的向量
        query_emb = emb_with_idx[0][1]
        with self._chrom_lock:
            self._ensure_fresh_client_by_marker()
            first = self._query_chroma_locked(query_emb, text, project_id, top_k)
            pid = str(project_id or "").strip()
            if not pid:
                return first

            # 自愈：若当前进程内 Chroma 查询视图陈旧，结果会退化为纯 lexical fallback（或空）。
            # 遇到此特征时重建 PersistentClient 并重试，尽量避免必须重启整个服务。
            fallback_kind = {
                "collection_get_lexical",
                "collection_get_lexical_scan",
            }
            max_retry = max(1, int(os.getenv("QUERY_CLIENT_REFRESH_RETRIES", "3")))

            def _is_lexical_only(rows: list[dict[str, Any]]) -> bool:
                return bool(rows) and all(
                    str((row or {}).get("fallback_source") or "") in fallback_kind for row in rows
                )

            current = first
            if not current or _is_lexical_only(current):
                try:
                    probe = self.collection.get(where={"project_id": pid}, limit=1, include=[])
                    has_project_docs = bool(probe.get("ids") or [])
                except Exception:  # noqa: S110
                    has_project_docs = False
                if has_project_docs:
                    for i in range(max_retry):
                        logger.warning(
                            "Query returned %s for %s; recreating Chroma client and retrying (%s/%s)",
                            "lexical fallback only" if _is_lexical_only(current) else "empty result",
                            pid,
                            i + 1,
                            max_retry,
                        )
                        self._recreate_persistent_chroma_client()
                        current = self._query_chroma_locked(query_emb, text, project_id, top_k)
                        if current and not _is_lexical_only(current):
                            return current
                        if i + 1 < max_retry:
                            time.sleep(0.15)
            return current

    def list_project_vectors(
        self,
        project_id: str,
        *,
        limit: int = 20,
        offset: int = 0,
        q: str | None = None,
    ) -> dict[str, Any]:
        pid = str(project_id).strip()
        if not pid:
            raise ValueError("project_id 不能为空")
        lim = max(1, min(200, int(limit)))
        off = max(0, int(offset))
        needle = (q or "").strip().lower()

        with self._chrom_lock:
            self._ensure_fresh_client_by_marker()
            if not needle:
                total_raw = self.collection.get(where={"project_id": pid}, include=[])
                total = len(total_raw.get("ids") or [])
                rows = self.collection.get(
                    where={"project_id": pid},
                    include=["documents", "metadatas"],
                    limit=lim,
                    offset=off,
                )
                ids = rows.get("ids") or []
                docs = rows.get("documents") or []
                metas = rows.get("metadatas") or []
                items: list[dict[str, Any]] = []
                for vid, doc, meta in zip(ids, docs, metas):
                    items.append(
                        {
                            "id": str(vid),
                            "content": str(doc or ""),
                            "metadata": meta or {},
                        }
                    )
                return {"total": total, "limit": lim, "offset": off, "items": items}

            # 关键词搜索：在项目内做子串匹配（id/path/name/content/metadata），再分页
            all_rows = self.collection.get(
                where={"project_id": pid},
                include=["documents", "metadatas"],
            )
            ids = all_rows.get("ids") or []
            docs = all_rows.get("documents") or []
            metas = all_rows.get("metadatas") or []

            matched: list[dict[str, Any]] = []
            for vid, doc, meta in zip(ids, docs, metas):
                m = meta or {}
                path = str(m.get("path") or m.get("file") or "")
                name = str(m.get("name") or "")
                hay = " ".join(
                    [
                        str(vid or ""),
                        path,
                        name,
                        str(doc or ""),
                        json.dumps(m, ensure_ascii=False, default=str),
                    ]
                ).lower()
                if needle in hay:
                    matched.append(
                        {
                            "id": str(vid),
                            "content": str(doc or ""),
                            "metadata": m,
                        }
                    )

            total = len(matched)
            page = matched[off : off + lim]
            return {"total": total, "limit": lim, "offset": off, "items": page}

    def update_project_vector(
        self,
        project_id: str,
        vector_id: str,
        *,
        content: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        pid = str(project_id).strip()
        vid = str(vector_id).strip()
        if not pid:
            raise ValueError("project_id 不能为空")
        if not vid:
            raise ValueError("vector_id 不能为空")

        with self._chrom_lock:
            self._ensure_fresh_client_by_marker()
            existing = self.collection.get(ids=[vid], include=["metadatas"])
            existing_ids = existing.get("ids") or []
            if not existing_ids:
                raise ValueError("向量条目不存在")
            existing_meta = (existing.get("metadatas") or [{}])[0] or {}
            existing_pid = str(existing_meta.get("project_id") or "").strip()
            if existing_pid and existing_pid != pid:
                raise ValueError("向量条目不属于该项目")

        text = str(content or "")
        clean_meta = self._sanitize_metadata(metadata or {})
        clean_meta["project_id"] = pid
        emb_with_idx = _embed([text], prefix="passage: ")
        emb = emb_with_idx[0][1]
        with self._chrom_lock:
            self._ensure_fresh_client_by_marker()
            self.collection.upsert(
                ids=[vid],
                embeddings=[emb],
                documents=[text],
                metadatas=[clean_meta],
            )
            _touch_chroma_reload_marker()
            self._recreate_persistent_chroma_client()
        return {"id": vid, "project_id": pid}


_store: VectorStore | None = None


def get_vector_store() -> VectorStore:
    global _store
    if _store is None:
        _store = VectorStore()
    else:
        with _store._chrom_lock:
            _store._ensure_fresh_client_by_marker()
    return _store
