from __future__ import annotations

import sqlite3
import logging
import os
import json
import threading
from datetime import datetime, timezone
from typing import Any

import httpx

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

from app.config import settings
from app.effective_settings import effective_embed_model

logger = logging.getLogger(__name__)
COLLECTION_NAME = "gitlab_code_docs"
_chroma_client: chromadb.PersistentClient | None = None
_project_index_db_lock = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _project_index_db_path() -> str:
    # 独立一个小库，避免与 index_jobs.sqlite3 的写入争用
    return str(settings.data_path / "project_index.sqlite3")


def _init_project_index_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_index (
            project_id TEXT PRIMARY KEY,
            doc_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )
        """
    )
    cols = {row[1] for row in conn.execute("PRAGMA table_info(project_index)").fetchall()}
    if "project_name" not in cols:
        conn.execute("ALTER TABLE project_index ADD COLUMN project_name TEXT NOT NULL DEFAULT ''")
    conn.commit()


def _read_project_index_from_db() -> list[dict[str, Any]]:
    db_path = _project_index_db_path()
    with _project_index_db_lock:
        conn = sqlite3.connect(db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            _init_project_index_db(conn)
            rows = conn.execute(
                """
                SELECT project_id, doc_count,
                       COALESCE(project_name, '') AS project_name
                FROM project_index
                ORDER BY project_id ASC
                """
            ).fetchall()
            return [
                {
                    "project_id": r["project_id"],
                    "doc_count": int(r["doc_count"]),
                    "project_name": (r["project_name"] or "").strip(),
                }
                for r in rows
            ]
        finally:
            conn.close()


def _upsert_project_index_in_db(project_id: str, doc_count: int, project_name: str = "") -> None:
    pname = (project_name or "").strip()
    now = _utc_now_iso()
    db_path = _project_index_db_path()
    with _project_index_db_lock:
        conn = sqlite3.connect(db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            _init_project_index_db(conn)
            conn.execute(
                """
                INSERT INTO project_index (project_id, doc_count, updated_at, project_name)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    doc_count = excluded.doc_count,
                    updated_at = excluded.updated_at,
                    project_name = CASE
                        WHEN TRIM(excluded.project_name) != '' THEN TRIM(excluded.project_name)
                        ELSE project_index.project_name
                    END
                """,
                (project_id, int(doc_count), now, pname),
            )
            conn.commit()
        finally:
            conn.close()


def _replace_project_index_in_db(project_stats: dict[str, int]) -> None:
    db_path = _project_index_db_path()
    with _project_index_db_lock:
        conn = sqlite3.connect(db_path, check_same_thread=False)
        try:
            _init_project_index_db(conn)
            conn.execute("DELETE FROM project_index")
            conn.executemany(
                """
                INSERT INTO project_index (project_id, doc_count, updated_at, project_name)
                VALUES (?, ?, ?, '')
                """,
                [(pid, int(count), _utc_now_iso()) for pid, count in project_stats.items()],
            )
            conn.commit()
        finally:
            conn.close()


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
    if _chroma_client is None:
        path = str(settings.chroma_path)
        settings.chroma_path.mkdir(parents=True, exist_ok=True)
        _chroma_client = chromadb.PersistentClient(
            path=path,
            settings=ChromaSettings(anonymized_telemetry=False),
        )
    return _chroma_client


def _embed(texts: list[str], prefix: str = "") -> list[tuple[int, list[float]]]:
    if not texts:
        return []
    if prefix:
        texts = [f"{prefix}{t}" for t in texts]

    model_name = effective_embed_model()
    base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

    # Ollama 向量模型也有上下文长度限制，这里做一个保守的字符截断防御。
    # 这里默认按 qwen3-embedding 40K context 估算，大约用 2 万字符作为安全上限，
    # 如需更精细可通过环境变量 EMBED_MAX_CHARS 调整。
    try:
        max_chars = int(os.getenv("EMBED_MAX_CHARS", "30000"))
    except ValueError:
        max_chars = 8000

    # 返回值中带有原始 texts 的索引，方便上层只写入成功的那几条
    embeddings: list[tuple[int, list[float]]] = []

    try:
        with httpx.Client(base_url=base_url, timeout=60.0) as client:
            for idx, raw_text in enumerate(texts):
                text = raw_text
                if len(text) > max_chars:
                    logger.warning(
                        "Embedding text length %s exceeds max_chars=%s, will be truncated to avoid Ollama context error.",
                        len(text),
                        max_chars,
                    )
                    text = text[:max_chars]

                try:
                    resp = client.post(
                        "/api/embeddings",
                        json={
                            "model": model_name,
                            # Ollama 官方接口使用 prompt 字段，而非 input
                            "prompt": text,
                        },
                    )
                    resp.raise_for_status()
                    data = resp.json()

                    # Ollama 常见返回格式：
                    # 1) {"embeddings": [[...], ...]}
                    # 2) {"data": [{"embedding": [...]} , ...]}
                    # 3) {"embedding": [...]}  # 单条输入时的旧格式
                    if isinstance(data, dict):
                        if "embeddings" in data:
                            emb_list = data["embeddings"]
                        elif "data" in data:
                            emb_list = [item["embedding"] for item in data["data"]]
                        elif "embedding" in data:
                            emb = data["embedding"]
                            # embedding 为空说明 Ollama 返回异常，直接报错而不是写入 0 维向量
                            if not emb:
                                raise RuntimeError("Ollama returned empty embedding")
                            if isinstance(emb[0], (int, float)):
                                emb_list = [emb]
                            else:
                                emb_list = emb
                        else:
                            raise RuntimeError(f"Unexpected Ollama embeddings response format: {data!r}")
                    else:
                        raise RuntimeError(f"Unexpected Ollama embeddings response format: {data!r}")

                    # 对于单条 input，理论上只会有一条向量，这里取第一条；若返回多条则全部追加
                    if emb_list and isinstance(emb_list[0], (int, float)):
                        embeddings.append((idx, emb_list))  # type: ignore[arg-type]
                    else:
                        for emb in emb_list:  # type: ignore[assignment]
                            embeddings.append((idx, emb))
                except Exception as e:  # noqa: S110
                    # 单条失败只打日志并跳过，后续文本继续
                    logger.error(
                        "Ollama embedding request failed for index %s: %s",
                        idx,
                        e,
                    )
                    continue
    except Exception as e:  # noqa: S110
        logger.exception("Unexpected error during embedding loop: %s", e)
        raise

    if not embeddings:
        # 所有条目都失败，让上层决定如何处理
        raise RuntimeError("All embedding requests failed")

    return embeddings


class VectorStore:
    def __init__(self):
        self.client = _get_chroma()
        self.collection = self.client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"description": "GitLab project code descriptions"},
        )

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
            project_stats = _scan_all_project_docs_from_vector_store(self.collection)
            _replace_project_index_in_db(project_stats)
        except Exception as e:  # noqa: S110
            logger.error("Backfill project_index from vector store failed: %s", e)

        return _read_project_index_from_db()

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
            full = self.collection.get(where={"project_id": pid}, include=[])
            doc_count = len(full.get("ids") or [])
        except Exception as e:  # noqa: S110
            logger.error("get_project_index_status count failed for %s: %s", pid, e)
            return {"project_id": pid, "indexed": True, "doc_count": 0}

        return {"project_id": pid, "indexed": True, "doc_count": doc_count}

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

    def upsert_project(
        self,
        project_id: str,
        chunks: list[dict[str, Any]],
        *,
        project_name: str = "",
    ) -> None:
        if not chunks:
            return
        ids = [f"{project_id}::{i}" for i in range(len(chunks))]
        documents = [c.get("content", "") for c in chunks]
        raw_metas = [{**c.get("metadata", {}), "project_id": project_id} for c in chunks]
        metadatas = [self._sanitize_metadata(m) for m in raw_metas]
        # 存文档时加 passage 前缀；若某条向量生成失败，只跳过该条；若全部失败则跳过整个项目
        try:
            emb_with_idx = _embed(documents, prefix="passage: ")
        except Exception as e:  # noqa: S110
            logger.error(
                "Embedding failed for project %s, skip upsert to vector store: %s",
                project_id,
                e,
            )
            return

        # 只保留成功生成向量的那些条目
        idx_to_emb: dict[int, list[float]] = {idx: emb for idx, emb in emb_with_idx}
        kept_ids: list[str] = []
        kept_docs: list[str] = []
        kept_metas: list[dict[str, Any]] = []
        kept_embs: list[list[float]] = []

        for i, (id_, doc, meta) in enumerate(zip(ids, documents, metadatas)):
            emb = idx_to_emb.get(i)
            if emb is None:
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
            logger.error(
                "No successful embeddings for project %s, skip upsert to vector store.",
                project_id,
            )
            return

        # 重新索引时，保证旧向量不会残留导致 doc_count 不准确。
        try:
            self.collection.delete(where={"project_id": project_id})
        except Exception as e:  # noqa: S110
            logger.warning("Delete old vectors failed for project %s: %s", project_id, e)

        self.collection.upsert(
            ids=kept_ids,
            embeddings=kept_embs,
            documents=kept_docs,
            metadatas=kept_metas,
        )
        logger.info("Upserted %s chunks for project %s", len(chunks), project_id)

        # 探测实际写入数量，写入缓存，避免 delete/upsert 部分失败导致统计不一致。
        try:
            full = self.collection.get(where={"project_id": project_id}, include=[])
            doc_count = len(full.get("ids") or [])
        except Exception as e:  # noqa: S110
            logger.warning("Failed to probe doc_count after upsert for %s: %s", project_id, e)
            doc_count = len(kept_ids)
        _upsert_project_index_in_db(project_id, doc_count, project_name)

    def query(
        self,
        text: str,
        project_id: str | None = None,
        top_k: int = 10,
    ) -> list[dict[str, Any]]:
        # 查询时加 query 前缀；若向量生成失败（如 Ollama 500），直接返回空结果，避免接口 500
        try:
            emb_with_idx = _embed([text], prefix="query: ")
        except Exception as e:  # noqa: S110
            logger.error("Embedding failed for query %r: %s", text[:200], e)
            return []
        if not emb_with_idx:
            logger.error("Embedding returned empty list for query %r", text[:200])
            return []
        # 只有一条 query 文本，这里取第一条成功的向量
        emb = [emb_with_idx[0][1]]
        where = {"project_id": project_id} if project_id else None
        results = self.collection.query(
            query_embeddings=emb,
            n_results=top_k,
            where=where,
            include=["documents", "metadatas", "distances"],
        )
        out = []
        docs = (results.get("documents") or [[]])[0]
        metas = (results.get("metadatas") or [[]])[0]
        dists = (results.get("distances") or [[]])[0]
        for d, m, dist in zip(docs, metas, dists):
            try:
                dist_f = float(dist) if dist is not None else None
            except (TypeError, ValueError):
                dist_f = None
            # Chroma 返回的是距离（越小越近）；API 同时给出 score 供前端展示「相似度」：越大越相关
            score = (1.0 / (1.0 + dist_f)) if dist_f is not None else None
            out.append({"content": d, "metadata": m or {}, "distance": dist_f, "score": score})
        return out


_store: VectorStore | None = None


def get_vector_store() -> VectorStore:
    global _store
    if _store is None:
        _store = VectorStore()
    return _store
