from __future__ import annotations

import logging

import httpx

from app.config import settings
from app.effective_settings import (
    effective_embed_model,
    effective_embed_provider,
    effective_ollama_api_key,
    effective_ollama_base_url,
    effective_openai_embed_api_key,
    effective_openai_embed_base_url,
)

logger = logging.getLogger(__name__)


def _embed_ollama(texts: list[str], max_chars: int) -> list[tuple[int, list[float]]]:
    model_name = effective_embed_model()
    base_url = effective_ollama_base_url()
    ollama_api_key = (effective_ollama_api_key() or "").strip()
    headers = {"Authorization": f"Bearer {ollama_api_key}"} if ollama_api_key else None
    embeddings: list[tuple[int, list[float]]] = []

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
                    headers=headers,
                    json={
                        "model": model_name,
                        "prompt": text,
                    },
                )
                resp.raise_for_status()
                data = resp.json()

                if isinstance(data, dict):
                    if "embeddings" in data:
                        emb_list = data["embeddings"]
                    elif "data" in data:
                        emb_list = [item["embedding"] for item in data["data"]]
                    elif "embedding" in data:
                        emb = data["embedding"]
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

                if emb_list and isinstance(emb_list[0], (int, float)):
                    embeddings.append((idx, emb_list))  # type: ignore[arg-type]
                else:
                    for emb in emb_list:  # type: ignore[assignment]
                        embeddings.append((idx, emb))
            except Exception as e:  # noqa: S110
                logger.error("Ollama embedding request failed for index %s: %s", idx, e)
                continue

    return embeddings


def _embed_openai(texts: list[str], max_chars: int) -> list[tuple[int, list[float]]]:
    model_name = (effective_embed_model() or "").strip()
    if not model_name:
        raise RuntimeError("embed_model is required for OpenAI embeddings")
    api_key = (effective_openai_embed_api_key() or "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_EMBED_API_KEY is required when embed_provider=openai")
    base = (effective_openai_embed_base_url() or "https://api.openai.com/v1").strip().rstrip("/")
    embeddings: list[tuple[int, list[float]]] = []

    with httpx.Client(base_url=base, timeout=60.0) as client:
        for idx, raw_text in enumerate(texts):
            text = raw_text
            if len(text) > max_chars:
                logger.warning(
                    "Embedding text length %s exceeds max_chars=%s, will be truncated.",
                    len(text),
                    max_chars,
                )
                text = text[:max_chars]

            try:
                resp = client.post(
                    "/embeddings",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={"model": model_name, "input": text},
                )
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    raise RuntimeError(f"Unexpected OpenAI embeddings response format: {data!r}")
                items = data.get("data")
                if not isinstance(items, list) or not items:
                    raise RuntimeError("OpenAI returned empty embeddings data")
                emb = items[0].get("embedding") if isinstance(items[0], dict) else None
                if not emb or not isinstance(emb, list):
                    raise RuntimeError("OpenAI returned empty embedding")
                embeddings.append((idx, emb))
            except Exception as e:  # noqa: S110
                logger.error("OpenAI embedding request failed for index %s: %s", idx, e)
                continue

    return embeddings


def _embed(texts: list[str], prefix: str = "") -> list[tuple[int, list[float]]]:
    if not texts:
        return []
    if prefix:
        texts = [f"{prefix}{t}" for t in texts]

    max_chars = settings.embed_max_chars
    provider = effective_embed_provider()

    try:
        if provider == "openai":
            embeddings = _embed_openai(texts, max_chars)
        else:
            embeddings = _embed_ollama(texts, max_chars)
    except Exception as e:  # noqa: S110
        logger.exception("Unexpected error during embedding loop: %s", e)
        raise

    if not embeddings:
        raise RuntimeError("All embedding requests failed")

    return embeddings


def precheck_embedding_connectivity() -> tuple[bool, str]:
    """索引前健康检查：按 embed_provider 检查嵌入接口。"""
    model = effective_embed_model().strip()
    if not model:
        return False, "未配置 embed_model"

    if effective_embed_provider() == "openai":
        api_key = (effective_openai_embed_api_key() or "").strip()
        if not api_key:
            return False, "已选择 OpenAI 嵌入，但未配置 OPENAI_EMBED_API_KEY"
        base = (effective_openai_embed_base_url() or "https://api.openai.com/v1").strip().rstrip("/")
        try:
            with httpx.Client(base_url=base, timeout=20.0) as client:
                resp = client.post(
                    "/embeddings",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={"model": model, "input": "health check"},
                )
                if resp.status_code >= 400:
                    return False, f"OpenAI embeddings HTTP {resp.status_code}"
                data = resp.json() if resp.content else {}
                items = data.get("data") if isinstance(data, dict) else None
                if isinstance(items, list) and items and isinstance(items[0], dict) and items[0].get("embedding"):
                    return True, f"OpenAI 嵌入可用（model={model}）"
                return False, "OpenAI 嵌入返回为空"
        except Exception as e:  # noqa: S110
            return False, str(e)

    base_url = (effective_ollama_base_url() or "http://localhost:11434").strip()
    ollama_api_key = (effective_ollama_api_key() or "").strip()
    headers = {"Authorization": f"Bearer {ollama_api_key}"} if ollama_api_key else None
    try:
        with httpx.Client(base_url=base_url, timeout=20.0) as client:
            resp = client.post("/api/embeddings", headers=headers, json={"model": model, "prompt": "health check"})
            if resp.status_code >= 400:
                return False, f"Ollama HTTP {resp.status_code}"
            data = resp.json() if resp.content else {}
            emb = data.get("embedding") if isinstance(data, dict) else None
            embs = data.get("embeddings") if isinstance(data, dict) else None
            if emb or embs:
                return True, f"Ollama 嵌入可用（model={model}）"
            return False, "embedding 返回为空"
    except Exception as e:  # noqa: S110
        return False, str(e)
