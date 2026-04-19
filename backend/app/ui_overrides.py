"""
管理后台在 data 目录下持久化的配置覆盖层（ui_overrides.json）。

合并规则：若某键在 JSON 中存在，则优先于环境变量 / .env（即 pydantic Settings）中的值；
键不存在时完全沿用 Settings。
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

_lock = threading.RLock()

# 允许通过管理 UI 读写的键（其它键即使出现在文件中也会被 PATCH 拒绝）
ALLOWED_OVERRIDE_KEYS: frozenset[str] = frozenset({
    "embed_model",
    "embed_provider",
    "ollama_base_url",
    "ollama_api_key",
    "openai_model",
    "openai_base_url",
    "openai_api_key",
    "openai_embed_base_url",
    "openai_embed_api_key",
    "dify_base_url",
    "dify_api_key",
    "llm_provider",
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
    "wiki_enabled",
    "wiki_backend",
    "wiki_max_file_pages",
    "wiki_symbol_rows_per_file",
    "npm_registry",
    "content_language",
    "index_exclude_patterns",
    "audit_retention_days",
})

SECRET_KEYS: frozenset[str] = frozenset({
    "ollama_api_key",
    "openai_api_key",
    "openai_embed_api_key",
    "dify_api_key",
    "azure_openai_api_key",
    "gitlab_access_token",
    "github_access_token",
    "gitee_access_token",
})


def overrides_path() -> Path:
    return settings.data_path / "ui_overrides.json"


def _read_file() -> dict[str, Any]:
    p = overrides_path()
    if not p.is_file():
        return {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {}
        return {str(k): v for k, v in raw.items() if isinstance(k, str)}
    except Exception as e:
        logger.warning("Failed to read ui_overrides.json: %s", e)
        return {}


def load_overrides() -> dict[str, Any]:
    with _lock:
        return _read_file()


def _atomic_write(data: dict[str, Any]) -> None:
    p = overrides_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)


def replace_overrides(new_data: dict[str, Any]) -> None:
    """整表替换（已校验键与类型）。"""
    with _lock:
        _atomic_write(new_data)


def merge_patch(patch: dict[str, Any]) -> dict[str, Any]:
    """
    patch 中值为 None 表示删除该键（恢复为环境变量）。
    返回合并后的完整 overrides。
    """
    with _lock:
        cur = _read_file()
        for k, v in patch.items():
            if k not in ALLOWED_OVERRIDE_KEYS:
                raise ValueError(f"unsupported key: {k}")
            if v is None:
                cur.pop(k, None)
            else:
                cur[k] = v
        _atomic_write(cur)
        return dict(cur)
