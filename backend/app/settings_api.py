"""
管理后台：读取 / 更新 UI 配置覆盖（与环境变量合并，见 effective_settings）。
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.audit_helpers import actor_from_user, request_meta
from app.audit_repo import append_audit_event
from app.auth_ui import require_ui_session
from app.effective_settings import env_defaults_for_api, snapshot_for_api
from app.llm_client import reset_llm_client_cache
from app.ui_overrides import ALLOWED_OVERRIDE_KEYS, merge_patch

logger = logging.getLogger(__name__)

router = APIRouter()


class AdminSettingsResponse(BaseModel):
    fields: dict[str, Any]
    env_defaults: dict[str, Any]


def _normalize_patch_item(key: str, raw: Any) -> Any:
    if raw is None:
        return None
    if key == "wiki_enabled":
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, str):
            return raw.strip().lower() in ("1", "true", "yes", "on")
        raise ValueError("wiki_enabled 须为布尔值")
    if key in ("wiki_max_file_pages", "wiki_symbol_rows_per_file", "audit_retention_days"):
        try:
            n = int(raw)
        except (TypeError, ValueError) as e:
            raise ValueError(f"{key} 须为整数") from e
        if not 1 <= n <= 100_000:
            raise ValueError(f"{key} 须在 1～100000 之间")
        return n
    if key == "wiki_backend":
        s = str(raw).strip().lower()
        if s not in ("mkdocs", "starlight", "vitepress"):
            raise ValueError("wiki_backend 须为 mkdocs、starlight 或 vitepress")
        return s
    if key == "llm_provider":
        s = str(raw).strip().lower().replace("-", "_")
        if s in ("auto", "legacy", ""):
            return "openai"
        if s == "dify":
            return "dify"
        if s in ("azure_openai", "azure"):
            return "azure_openai"
        if s in ("openai", "openai_compat"):
            return "openai"
        raise ValueError("llm_provider 须为 dify、azure_openai 或 openai")
    if key == "embed_provider":
        s = str(raw).strip().lower().replace("-", "_")
        if s in ("openai", "openai_compat"):
            return "openai"
        if s in ("ollama", ""):
            return "ollama"
        raise ValueError("embed_provider 须为 ollama 或 openai")
    if key == "content_language":
        s = str(raw).strip().lower()
        if s not in ("zh", "en"):
            raise ValueError("content_language 须为 zh 或 en")
        return s
    if key == "index_exclude_patterns":
        if not isinstance(raw, str):
            raw = str(raw)
        s = raw.strip()
        if len(s) > 65536:
            raise ValueError("index_exclude_patterns 过长（最多 65536 字符）")
        return s
    if key in (
        "embed_model",
        "ollama_base_url",
        "ollama_api_key",
        "openai_model",
        "openai_base_url",
        "openai_api_key",
        "openai_embed_base_url",
        "openai_embed_api_key",
        "dify_base_url",
        "dify_api_key",
        "azure_openai_api_key",
        "azure_openai_endpoint",
        "azure_openai_version",
        "azure_openai_deployment",
        "gitlab_access_token",
        "github_access_token",
        "gitee_access_token",
        "git_https_username",
        "gitlab_https_username",
        "github_https_username",
        "gitee_https_username",
        "npm_registry",
        "content_language",
    ):
        if not isinstance(raw, str):
            raw = str(raw)
        s = raw.strip()
        if key == "ollama_base_url" and s == "":
            # 允许在 UI 中清空地址来回退环境变量。
            return None
        if key == "openai_embed_base_url" and s == "":
            return None
        if key in (
            "ollama_api_key",
            "openai_api_key",
            "openai_embed_api_key",
            "dify_api_key",
            "azure_openai_api_key",
            "gitlab_access_token",
        ):
            if s == "***":
                raise ValueError("请勿将掩码 *** 作为密钥提交")
        return s
    raise ValueError(f"未知字段: {key}")


@router.get("/admin/settings", response_model=AdminSettingsResponse)
def get_admin_settings(_user: Annotated[Optional[str], Depends(require_ui_session)]):
    return AdminSettingsResponse(fields=snapshot_for_api(), env_defaults=env_defaults_for_api())


@router.patch("/admin/settings", response_model=AdminSettingsResponse)
def patch_admin_settings(
    body: dict[str, Any],
    request: Request,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="请求体须为 JSON 对象")
    normalized: dict[str, Any] = {}
    for k, v in body.items():
        if k not in ALLOWED_OVERRIDE_KEYS:
            raise HTTPException(status_code=400, detail=f"不允许修改的字段: {k}")
        try:
            normalized[k] = _normalize_patch_item(k, v)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    try:
        merge_patch(normalized)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    reset_llm_client_cache()
    meta = request_meta(request)
    append_audit_event(
        event_type="admin.settings.patch",
        actor=actor_from_user(_user),
        route=meta["route"],
        method=meta["method"],
        resource_type="admin_settings",
        status="ok",
        payload={"changed_keys": sorted(normalized.keys())},
        ip=meta["ip"],
        user_agent=meta["user_agent"],
    )
    logger.info("admin settings updated: %s", ", ".join(sorted(normalized.keys())) or "(no-op)")
    return AdminSettingsResponse(fields=snapshot_for_api(), env_defaults=env_defaults_for_api())
