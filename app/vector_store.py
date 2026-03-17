from __future__ import annotations

import logging
import os
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

logger = logging.getLogger(__name__)
COLLECTION_NAME = "gitlab_code_docs"
_chroma_client: chromadb.PersistentClient | None = None


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


def _embed(texts: list[str], prefix: str = "") -> list[list[float]]:
    if not texts:
        return []
    if prefix:
        texts = [f"{prefix}{t}" for t in texts]

    model_name = settings.embed_model
    base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

    embeddings: list[list[float]] = []

    try:
        with httpx.Client(base_url=base_url, timeout=60.0) as client:
            for text in texts:
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
                    embeddings.append(emb_list)  # type: ignore[arg-type]
                else:
                    embeddings.extend(emb_list)  # type: ignore[arg-type]
    except Exception as e:  # noqa: S110
        logger.exception("Ollama embedding request failed: %s", e)
        raise

    return embeddings


class VectorStore:
    def __init__(self):
        self.client = _get_chroma()
        self.collection = self.client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"description": "GitLab project code descriptions"},
        )

    def upsert_project(self, project_id: str, chunks: list[dict[str, Any]]) -> None:
        if not chunks:
            return
        ids = [f"{project_id}::{i}" for i in range(len(chunks))]
        documents = [c.get("content", "") for c in chunks]
        metadatas = [{**c.get("metadata", {}), "project_id": project_id} for c in chunks]
        # 存文档时加 passage 前缀；若向量生成失败（如 Ollama 500），记录错误并跳过向量写入，避免整个索引中断
        try:
            embeddings = _embed(documents, prefix="passage: ")
        except Exception as e:  # noqa: S110
            logger.error(
                "Embedding failed for project %s, skip upsert to vector store: %s",
                project_id,
                e,
            )
            return
        self.collection.upsert(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)
        logger.info("Upserted %s chunks for project %s", len(chunks), project_id)

    def query(
        self,
        text: str,
        project_id: str | None = None,
        top_k: int = 10,
    ) -> list[dict[str, Any]]:
        # 查询时加 query 前缀；若向量生成失败（如 Ollama 500），直接返回空结果，避免接口 500
        try:
            emb = _embed([text], prefix="query: ")
        except Exception as e:  # noqa: S110
            logger.error("Embedding failed for query %r: %s", text[:200], e)
            return []
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
            out.append({"content": d, "metadata": m or {}, "distance": dist})
        return out


_store: VectorStore | None = None


def get_vector_store() -> VectorStore:
    global _store
    if _store is None:
        _store = VectorStore()
    return _store
