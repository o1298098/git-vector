from __future__ import annotations

import math
import re
from typing import Any

try:
    import numpy as np
except Exception:  # noqa: S110
    np = None  # type: ignore[assignment]


def query_tokens_for_boost(text: str) -> list[str]:
    q = str(text or "").strip().lower()
    if not q:
        return []
    tokens: set[str] = {q}
    tokens.update(t for t in re.split(r"[^0-9a-zA-Z_\-./]+", q) if len(t) >= 2)
    # 限制 token 数量，避免极长 query 增加过多 CPU 开销
    return list(tokens)[:12]


def keyword_boost_for_hit(tokens: list[str], content: str, metadata: dict[str, Any]) -> float:
    if not tokens:
        return 0.0
    path = str(metadata.get("path") or "").lower()
    name = str(metadata.get("name") or metadata.get("symbol") or "").lower()
    tags_csv = str(metadata.get("tags_csv") or "").lower()
    calls_csv = str(metadata.get("calls_csv") or "").lower()
    hay = str(content or "").lower()
    boost = 0.0
    for tk in tokens:
        if tk in path:
            boost += 0.10
        if tk in name:
            boost += 0.08
        if tags_csv and tk in tags_csv:
            boost += 0.12
        if calls_csv and tk in calls_csv:
            boost += 0.12
        if tk in hay:
            boost += 0.03
    return min(0.35, boost)


def coerce_embedding_to_float_list(emb: Any) -> list[float] | None:
    """
    Chroma get(include=['embeddings']) 常返回 numpy.ndarray，而 httpx 解析的 query 向量是 list。
    仅接受「单条」向量（一维或 shape (1, dim)）；整块 (n, dim) 应在调用方按行切片后再传入。
    """
    if emb is None:
        return None
    if np is not None and isinstance(emb, np.ndarray):
        if emb.ndim > 1:
            if emb.shape[0] != 1:
                return None
            emb = emb.reshape(-1)
        if emb.size == 0:
            return None
        return [float(x) for x in emb.ravel()]
    if isinstance(emb, (list, tuple)):
        try:
            out = [float(x) for x in emb]
        except (TypeError, ValueError):
            return None
        return out if out else None
    if hasattr(emb, "tolist") and not isinstance(emb, (str, bytes)):
        try:
            raw = emb.tolist()
        except Exception:  # noqa: S110
            return None
        return coerce_embedding_to_float_list(raw)
    return None


def vector_score_from_embeddings(query_emb: list[float], hit_emb: Any) -> tuple[float | None, float | None]:
    """
    回退检索时基于已存 embedding 计算相似度分数。
    返回 (score, distance)，score 越大越相关，distance 越小越近。
    """
    q = coerce_embedding_to_float_list(query_emb)
    h = coerce_embedding_to_float_list(hit_emb)
    if not q or not h:
        return None, None
    if len(h) != len(q):
        return None, None
    try:
        qn = math.sqrt(sum(float(x) * float(x) for x in q))
        hn = math.sqrt(sum(float(x) * float(x) for x in h))
        if qn <= 0 or hn <= 0:
            return None, None
        dot = sum(float(a) * float(b) for a, b in zip(q, h))
        cosine = dot / (qn * hn)
        # 约束到 [-1, 1]，并映射到 [0, 1] 便于与主路径 score 对齐展示。
        cosine = max(-1.0, min(1.0, cosine))
        score = (cosine + 1.0) / 2.0
        distance = 1.0 - score
        return score, distance
    except (TypeError, ValueError, OverflowError):
        return None, None
