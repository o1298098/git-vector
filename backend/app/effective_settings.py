"""
运行时有效配置：UI 覆盖层（ui_overrides.json）优先，否则使用 app.config.settings（含环境变量）。
"""

from __future__ import annotations

from typing import Any, Literal
from urllib.parse import urlparse

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


def effective_embed_provider() -> str:
    """ollama | openai"""
    raw = _str_from_override("embed_provider", settings.embed_provider or "ollama").strip().lower().replace("-", "_")
    if raw in ("openai", "openai_compat"):
        return "openai"
    return "ollama"


def effective_ollama_base_url() -> str:
    v = _str_from_override("ollama_base_url", settings.ollama_base_url or "http://localhost:11434")
    return (v or "").strip() or (settings.ollama_base_url or "http://localhost:11434")


def effective_ollama_api_key() -> str:
    return _str_from_override("ollama_api_key", settings.ollama_api_key or "")


def effective_openai_model() -> str:
    return _str_from_override("openai_model", settings.openai_model)


def effective_openai_base_url() -> str:
    return _str_from_override("openai_base_url", settings.openai_base_url or "https://api.openai.com/v1")


def effective_openai_api_key() -> str:
    return _str_from_override("openai_api_key", settings.openai_api_key or "")


def effective_openai_embed_base_url() -> str:
    v = _str_from_override(
        "openai_embed_base_url",
        settings.openai_embed_base_url or "https://api.openai.com/v1",
    )
    return (v or "").strip() or (settings.openai_embed_base_url or "https://api.openai.com/v1")


def effective_openai_embed_api_key() -> str:
    return _str_from_override("openai_embed_api_key", settings.openai_embed_api_key or "")


def effective_dify_base_url() -> str:
    return _str_from_override("dify_base_url", settings.dify_base_url or "")


def effective_dify_api_key() -> str:
    return _str_from_override("dify_api_key", settings.dify_api_key or "")


def effective_llm_provider() -> str:
    """dify | azure_openai | openai（默认 openai；历史 auto 等同 openai）"""
    raw = _str_from_override("llm_provider", settings.llm_provider or "openai").strip().lower().replace("-", "_")
    if raw in ("auto", "legacy", ""):
        return "openai"
    if raw == "dify":
        return "dify"
    if raw in ("azure_openai", "azure"):
        return "azure_openai"
    if raw in ("openai", "openai_compat"):
        return "openai"
    return "openai"


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


def effective_github_access_token() -> str:
    return _str_from_override("github_access_token", settings.github_access_token or "")


def effective_gitee_access_token() -> str:
    return _str_from_override("gitee_access_token", settings.gitee_access_token or "")


def detect_git_provider(repo_url: str) -> str:
    raw = str(repo_url or "").strip().lower()
    if not raw:
        return "generic"
    if raw.startswith("git@"):
        host_part = raw.split(":", 1)[0].split("@", 1)[-1]
    else:
        try:
            parsed = urlparse(raw)
            host_part = (parsed.hostname or "").lower()
        except Exception:
            host_part = ""
    if host_part in ("github.com", "www.github.com") or host_part.endswith(".github.com"):
        return "github"
    if host_part in ("gitee.com", "www.gitee.com") or host_part.endswith(".gitee.com"):
        return "gitee"
    if host_part in ("gitlab.com", "www.gitlab.com") or host_part.endswith(".gitlab.com"):
        return "gitlab"
    return "generic"


def effective_git_https_token(repo_url: str = "") -> str:
    """HTTPS 克隆令牌：GIT_HTTPS_TOKEN 优先，否则按仓库提供商回退到对应 PAT。"""
    env_tok = (settings.git_https_token or "").strip()
    if env_tok:
        return env_tok
    provider = detect_git_provider(repo_url)
    if provider == "github":
        return effective_github_access_token()
    if provider == "gitee":
        return effective_gitee_access_token()
    return effective_gitlab_access_token()


def stored_git_https_username() -> str:
    return _str_from_override("git_https_username", settings.git_https_username or "")


def stored_gitlab_https_username() -> str:
    return _str_from_override("gitlab_https_username", settings.gitlab_https_username or "")


def stored_github_https_username() -> str:
    return _str_from_override("github_https_username", settings.github_https_username or "")


def stored_gitee_https_username() -> str:
    return _str_from_override("gitee_https_username", settings.gitee_https_username or "")


def effective_git_https_username(repo_url: str = "") -> str:
    provider = detect_git_provider(repo_url)
    if provider == "github":
        u = stored_github_https_username().strip() or stored_git_https_username().strip()
        return u if u else "x-access-token"
    if provider == "gitee":
        u = stored_gitee_https_username().strip() or stored_git_https_username().strip()
        return u if u else "oauth2"
    u = stored_gitlab_https_username().strip() or stored_git_https_username().strip()
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
    raw = _str_from_override("content_language", settings.content_language or "en")
    return "en" if str(raw).strip().lower().startswith("en") else "zh"


def effective_index_exclude_patterns() -> str:
    return _str_from_override("index_exclude_patterns", settings.index_exclude_patterns or "")


def effective_audit_retention_days() -> int:
    if "audit_retention_days" not in _overrides():
        return int(settings.audit_retention_days)
    try:
        return int(_overrides()["audit_retention_days"])
    except (TypeError, ValueError):
        return int(settings.audit_retention_days)


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
        "embed_provider": {"value": effective_embed_provider(), "source": field_source("embed_provider")},
        "ollama_base_url": {"value": effective_ollama_base_url(), "source": field_source("ollama_base_url")},
        "ollama_api_key": {"value": sec_effective(effective_ollama_api_key, "ollama_api_key"), "source": field_source("ollama_api_key")},
        "openai_model": {"value": effective_openai_model(), "source": field_source("openai_model")},
        "openai_base_url": {"value": effective_openai_base_url(), "source": field_source("openai_base_url")},
        "openai_api_key": {"value": sec_effective(effective_openai_api_key, "openai_api_key"), "source": field_source("openai_api_key")},
        "openai_embed_base_url": {
            "value": effective_openai_embed_base_url(),
            "source": field_source("openai_embed_base_url"),
        },
        "openai_embed_api_key": {
            "value": sec_effective(effective_openai_embed_api_key, "openai_embed_api_key"),
            "source": field_source("openai_embed_api_key"),
        },
        "dify_base_url": {"value": effective_dify_base_url(), "source": field_source("dify_base_url")},
        "dify_api_key": {"value": sec_effective(effective_dify_api_key, "dify_api_key"), "source": field_source("dify_api_key")},
        "llm_provider": {"value": effective_llm_provider(), "source": field_source("llm_provider")},
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
        "github_access_token": {
            "value": sec_effective(effective_github_access_token, "github_access_token"),
            "source": field_source("github_access_token"),
        },
        "gitee_access_token": {
            "value": sec_effective(effective_gitee_access_token, "gitee_access_token"),
            "source": field_source("gitee_access_token"),
        },
        "git_https_username": {"value": stored_git_https_username().strip(), "source": field_source("git_https_username")},
        "gitlab_https_username": {"value": stored_gitlab_https_username().strip(), "source": field_source("gitlab_https_username")},
        "github_https_username": {"value": stored_github_https_username().strip(), "source": field_source("github_https_username")},
        "gitee_https_username": {"value": stored_gitee_https_username().strip(), "source": field_source("gitee_https_username")},
        "wiki_enabled": {"value": effective_wiki_enabled(), "source": field_source("wiki_enabled")},
        "wiki_backend": {"value": effective_wiki_backend(), "source": field_source("wiki_backend")},
        "wiki_max_file_pages": {"value": effective_wiki_max_file_pages(), "source": field_source("wiki_max_file_pages")},
        "wiki_symbol_rows_per_file": {
            "value": effective_wiki_symbol_rows_per_file(),
            "source": field_source("wiki_symbol_rows_per_file"),
        },
        "npm_registry": {"value": effective_npm_registry(), "source": field_source("npm_registry")},
        "content_language": {"value": effective_content_language(), "source": field_source("content_language")},
        "index_exclude_patterns": {"value": effective_index_exclude_patterns(), "source": field_source("index_exclude_patterns")},
        "audit_retention_days": {"value": effective_audit_retention_days(), "source": field_source("audit_retention_days")},
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
        "embed_provider": str(s.embed_provider or "ollama"),
        "ollama_base_url": s.ollama_base_url,
        "ollama_api_key": mask("ollama_api_key"),
        "openai_model": s.openai_model,
        "openai_base_url": s.openai_base_url,
        "openai_api_key": mask("openai_api_key"),
        "openai_embed_base_url": s.openai_embed_base_url,
        "openai_embed_api_key": mask("openai_embed_api_key"),
        "dify_base_url": s.dify_base_url,
        "dify_api_key": mask("dify_api_key"),
        "llm_provider": str(s.llm_provider or "openai"),
        "azure_openai_api_key": mask("azure_openai_api_key"),
        "azure_openai_endpoint": s.azure_openai_endpoint,
        "azure_openai_version": s.azure_openai_version,
        "azure_openai_deployment": s.azure_openai_deployment,
        "gitlab_access_token": mask("gitlab_access_token"),
        "github_access_token": mask("github_access_token"),
        "gitee_access_token": mask("gitee_access_token"),
        "git_https_username": s.git_https_username or "",
        "gitlab_https_username": s.gitlab_https_username or "",
        "github_https_username": s.github_https_username or "",
        "gitee_https_username": s.gitee_https_username or "",
        "wiki_enabled": bool(s.wiki_enabled),
        "wiki_backend": str(s.wiki_backend),
        "wiki_max_file_pages": int(s.wiki_max_file_pages),
        "wiki_symbol_rows_per_file": int(s.wiki_symbol_rows_per_file),
        "npm_registry": s.npm_registry or "",
        "content_language": str(s.content_language or "zh"),
        "index_exclude_patterns": str(s.index_exclude_patterns or ""),
        "audit_retention_days": int(s.audit_retention_days),
    }
