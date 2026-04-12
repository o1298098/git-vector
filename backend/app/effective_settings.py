"""
运行时有效配置：UI 覆盖层（ui_overrides.json）优先，否则使用 app.config.settings（含环境变量）。
"""

from __future__ import annotations

from typing import Any, Literal

from app.config import Settings, settings
from app.ui_overrides import load_overrides

WikiBackend = Literal["mkdocs", "starlight", "vitepress"]


def _overrides() -> dict[str, Any]:
    return load_overrides()


def _has_override(key: str) -> bool:
    return key in _overrides()


def _str_from_override(key: str, base: str) -> str:
    if key not in _overrides():
        return base
    v = _overrides()[key]
    if v is None:
        return base
    return str(v).strip() if isinstance(v, str) else str(v)


def effective_embed_model() -> str:
    return _str_from_override("embed_model", settings.embed_model)


def effective_openai_model() -> str:
    return _str_from_override("openai_model", settings.openai_model)


def effective_openai_base_url() -> str:
    return _str_from_override("openai_base_url", settings.openai_base_url or "https://api.openai.com/v1")


def effective_openai_api_key() -> str:
    return _str_from_override("openai_api_key", settings.openai_api_key or "")


def effective_dify_base_url() -> str:
    return _str_from_override("dify_base_url", settings.dify_base_url or "")


def effective_dify_api_key() -> str:
    return _str_from_override("dify_api_key", settings.dify_api_key or "")


def effective_azure_openai_api_key() -> str:
    return _str_from_override("azure_openai_api_key", settings.azure_openai_api_key or "")


def effective_azure_openai_endpoint() -> str:
    return _str_from_override("azure_openai_endpoint", settings.azure_openai_endpoint or "")


def effective_azure_openai_version() -> str:
    return _str_from_override("azure_openai_version", settings.azure_openai_version or "2024-05-01-preview")


def effective_azure_openai_deployment() -> str:
    return _str_from_override("azure_openai_deployment", settings.azure_openai_deployment or "gpt-4o-mini")


def effective_gitlab_access_token() -> str:
    return _str_from_override("gitlab_access_token", settings.gitlab_access_token or "")


def effective_git_https_token() -> str:
    """HTTPS 克隆令牌：GIT_HTTPS_TOKEN 优先，否则 GITLAB_ACCESS_TOKEN / 界面 gitlab_access_token。"""
    env_tok = (settings.git_https_token or "").strip()
    if env_tok:
        return env_tok
    return effective_gitlab_access_token()


def stored_git_https_username() -> str:
    """界面/环境变量中的原始值；空字符串表示克隆时回退为 oauth2。"""
    return _str_from_override("git_https_username", settings.git_https_username or "")


def effective_git_https_username() -> str:
    u = stored_git_https_username().strip()
    return u if u else "oauth2"


def effective_wiki_enabled() -> bool:
    if "wiki_enabled" not in _overrides():
        return bool(settings.wiki_enabled)
    return bool(_overrides()["wiki_enabled"])


def effective_wiki_backend() -> WikiBackend:
    if "wiki_backend" not in _overrides():
        raw = str(settings.wiki_backend or "mkdocs").strip().lower()
    else:
        raw = str(_overrides()["wiki_backend"] or "mkdocs").strip().lower()
    if raw in ("mkdocs", "starlight", "vitepress"):
        return raw  # type: ignore[return-value]
    return "mkdocs"


def effective_wiki_max_file_pages() -> int:
    if "wiki_max_file_pages" not in _overrides():
        return int(settings.wiki_max_file_pages)
    try:
        return int(_overrides()["wiki_max_file_pages"])
    except (TypeError, ValueError):
        return int(settings.wiki_max_file_pages)


def effective_wiki_symbol_rows_per_file() -> int:
    if "wiki_symbol_rows_per_file" not in _overrides():
        return int(settings.wiki_symbol_rows_per_file)
    try:
        return int(_overrides()["wiki_symbol_rows_per_file"])
    except (TypeError, ValueError):
        return int(settings.wiki_symbol_rows_per_file)


def effective_npm_registry() -> str:
    return _str_from_override("npm_registry", settings.npm_registry or "")


def effective_content_language() -> str:
    raw = _str_from_override("content_language", settings.content_language or "zh")
    return "en" if str(raw).strip().lower().startswith("en") else "zh"


def field_source(key: str) -> str:
    """\"override\" 或 \"env\"（env 表示沿用 Settings / 环境变量）。"""
    return "override" if _has_override(key) else "env"


def snapshot_for_api() -> dict[str, Any]:
    """供 GET /api/admin/settings：有效值 + 是否来自 UI 覆盖；密钥类永不返回明文。"""
    from app.ui_overrides import SECRET_KEYS

    def sec_effective(getter: Any, key: str) -> str:
        v = getter()
        if key in SECRET_KEYS:
            return "***" if (v or "").strip() else ""
        return v if isinstance(v, str) else str(v)

    return {
        "embed_model": {"value": effective_embed_model(), "source": field_source("embed_model")},
        "openai_model": {"value": effective_openai_model(), "source": field_source("openai_model")},
        "openai_base_url": {"value": effective_openai_base_url(), "source": field_source("openai_base_url")},
        "openai_api_key": {"value": sec_effective(effective_openai_api_key, "openai_api_key"), "source": field_source("openai_api_key")},
        "dify_base_url": {"value": effective_dify_base_url(), "source": field_source("dify_base_url")},
        "dify_api_key": {"value": sec_effective(effective_dify_api_key, "dify_api_key"), "source": field_source("dify_api_key")},
        "azure_openai_api_key": {
            "value": sec_effective(effective_azure_openai_api_key, "azure_openai_api_key"),
            "source": field_source("azure_openai_api_key"),
        },
        "azure_openai_endpoint": {
            "value": effective_azure_openai_endpoint(),
            "source": field_source("azure_openai_endpoint"),
        },
        "azure_openai_version": {"value": effective_azure_openai_version(), "source": field_source("azure_openai_version")},
        "azure_openai_deployment": {
            "value": effective_azure_openai_deployment(),
            "source": field_source("azure_openai_deployment"),
        },
        "gitlab_access_token": {
            "value": sec_effective(effective_gitlab_access_token, "gitlab_access_token"),
            "source": field_source("gitlab_access_token"),
        },
        "git_https_username": {"value": stored_git_https_username().strip(), "source": field_source("git_https_username")},
        "wiki_enabled": {"value": effective_wiki_enabled(), "source": field_source("wiki_enabled")},
        "wiki_backend": {"value": effective_wiki_backend(), "source": field_source("wiki_backend")},
        "wiki_max_file_pages": {"value": effective_wiki_max_file_pages(), "source": field_source("wiki_max_file_pages")},
        "wiki_symbol_rows_per_file": {
            "value": effective_wiki_symbol_rows_per_file(),
            "source": field_source("wiki_symbol_rows_per_file"),
        },
        "npm_registry": {"value": effective_npm_registry(), "source": field_source("npm_registry")},
        "content_language": {"value": effective_content_language(), "source": field_source("content_language")},
    }


def env_defaults_for_api() -> dict[str, Any]:
    """不含 UI 覆盖时 pydantic 解析到的基线（密钥仍打码）。"""
    from app.ui_overrides import SECRET_KEYS

    s: Settings = settings

    def mask(attr: str) -> str:
        v = (getattr(s, attr, None) or "") if isinstance(getattr(s, attr, None), str) else str(getattr(s, attr, "") or "")
        return "***" if attr in SECRET_KEYS and v.strip() else v

    return {
        "embed_model": s.embed_model,
        "openai_model": s.openai_model,
        "openai_base_url": s.openai_base_url,
        "openai_api_key": mask("openai_api_key"),
        "dify_base_url": s.dify_base_url,
        "dify_api_key": mask("dify_api_key"),
        "azure_openai_api_key": mask("azure_openai_api_key"),
        "azure_openai_endpoint": s.azure_openai_endpoint,
        "azure_openai_version": s.azure_openai_version,
        "azure_openai_deployment": s.azure_openai_deployment,
        "gitlab_access_token": mask("gitlab_access_token"),
        "git_https_username": s.git_https_username or "",
        "wiki_enabled": bool(s.wiki_enabled),
        "wiki_backend": str(s.wiki_backend),
        "wiki_max_file_pages": int(s.wiki_max_file_pages),
        "wiki_symbol_rows_per_file": int(s.wiki_symbol_rows_per_file),
        "npm_registry": s.npm_registry or "",
        "content_language": str(s.content_language or "zh"),
    }
