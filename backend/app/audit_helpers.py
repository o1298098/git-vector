from __future__ import annotations

from hashlib import sha256
from typing import Any


def actor_from_user(user: str | None) -> str:
    u = str(user or "").strip()
    return u if u else "anonymous"


def request_meta(request: Any) -> dict[str, str]:
    client_host = ""
    if request.client is not None and request.client.host:
        client_host = str(request.client.host)
    return {
        "route": str(request.url.path),
        "method": str(request.method or "").upper(),
        "ip": client_host,
        "user_agent": str(request.headers.get("user-agent") or ""),
    }


def mask_query_payload(text: str, *, preview_len: int = 80) -> dict[str, Any]:
    raw = str(text or "")
    preview = raw[:preview_len]
    if len(raw) > preview_len:
        preview += "..."
    return {
        "masked_preview": preview,
        "raw_len": len(raw),
        "sha256": sha256(raw.encode("utf-8")).hexdigest(),
    }


def build_provider_audit_payload(
    *,
    provider: str,
    model: str = "",
    endpoint: str = "",
    http_status_code: int | None = None,
    ok: bool | None = None,
    latency_ms: int | None = None,
    error_type: str = "",
    error_message: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "provider": str(provider or "").strip(),
        "model": str(model or "").strip(),
        "endpoint": str(endpoint or "").strip(),
    }
    if http_status_code is not None:
        payload["http_status_code"] = int(http_status_code)
    if ok is not None:
        payload["ok"] = bool(ok)
    if latency_ms is not None:
        payload["latency_ms"] = max(0, int(latency_ms))
    if error_type:
        payload["error_type"] = str(error_type).strip()[:120]
    if error_message:
        payload["error_message"] = str(error_message).strip()[:500]
    if extra:
        for k, v in extra.items():
            if v is not None:
                payload[str(k)] = v
    return payload
