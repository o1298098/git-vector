from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

WikiBackend = Literal["mkdocs", "starlight", "vitepress"]


def _dotenv_files() -> tuple[str, ...]:
    """本地 monorepo：优先仓库根 .env；其次 backend/.env；镜像内仅 /app/.env。"""
    service_root = Path(__file__).resolve().parent.parent
    repo_root = service_root.parent
    candidates: list[Path] = []
    if (repo_root / "frontend").is_dir():
        candidates.append(repo_root / ".env")
    candidates.append(service_root / ".env")
    existing = tuple(str(p) for p in candidates if p.is_file())
    return existing if existing else (".env",)


class Settings(BaseSettings):
    gitlab_webhook_secret: str = ""
    # GitHub：仓库 Webhooks → Secret；验签头 X-Hub-Signature-256（未设置则跳过验签）
    github_webhook_secret: str = ""
    # Gitea：与 GitHub 类似，验签头 X-Gitea-Signature（body 的 HMAC-SHA256 十六进制；未设置则跳过）
    gitea_webhook_secret: str = ""
    gitlab_access_token: str = ""
    github_access_token: str = ""
    gitee_access_token: str = ""
    # 优先于分平台 token：任意 Git 托管的 HTTPS 克隆令牌（PAT 等）
    git_https_token: str = ""
    # 通用 HTTPS 克隆用户名；未按平台配置时作为兜底
    git_https_username: str = ""
    gitlab_https_username: str = ""
    github_https_username: str = ""
    gitee_https_username: str = ""
    # 概览「打开仓库」无任务记录时的兜底：与 project_id（path/with/namespace）拼接，如 https://gitlab.com
    gitlab_external_url: str = ""
    # 索引 / Wiki 中 LLM 生成说明的语言：zh | en（默认英文）
    content_language: str = "en"
    dify_api_key: str = ""
    dify_base_url: str = "https://api.dify.ai/v1"
    # LLM 供应商：dify | azure_openai | openai（仅使用所选供应商）
    llm_provider: str = "openai"
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o-mini"  # OpenAI 为模型名；Azure 填部署名
    # 嵌入用 OpenAI 兼容接口（可与上方 LLM 的 OPENAI_* 指向不同服务商）
    openai_embed_base_url: str = "https://api.openai.com/v1"
    openai_embed_api_key: str = ""
    # Azure OpenAI（优先于 OPENAI_* 使用，需同时填 endpoint + key + version + deployment）
    azure_openai_api_key: str = ""
    azure_openai_endpoint: str = ""
    azure_openai_version: str = "2024-05-01-preview"
    azure_openai_deployment: str = "gpt-4o-mini"  # 部署名，与 Azure 门户中一致
    data_dir: str = "./data"
    # Ollama 服务地址（embedding 调用基地址）
    ollama_base_url: str = "http://localhost:11434"
    # Ollama 访问密钥（若接入反向代理或网关可配置）
    ollama_api_key: str = ""
    # 嵌入供应商：ollama | openai（OpenAI 使用 OPENAI_EMBED_BASE_URL / OPENAI_EMBED_API_KEY）
    embed_provider: str = "ollama"
    # 嵌入模型名：Ollama 下为 Ollama 模型名；OpenAI 下为 embeddings 模型名（如 text-embedding-3-small）
    embed_model: str = "intfloat/multilingual-e5-large"
    # embedding 文本最大字符数（超长时截断，避免上下文窗口报错）
    embed_max_chars: int = 30000
    # 索引成功后是否生成静态 Wiki（见 README / .env.example）
    wiki_enabled: bool = True
    # mkdocs：纯 Python；starlight / vitepress：需 Node.js + npm，首次会 npm install
    wiki_backend: WikiBackend = Field(default="mkdocs")
    wiki_max_file_pages: int = 5000
    wiki_symbol_rows_per_file: int = 4000
    # Starlight / VitePress 构建时 npm 使用的 registry；非空则注入环境变量 npm_config_registry
    npm_registry: str = ""
    # 管理后台 Web 登录（仅用于 /admin 会话；不设密码则前端无需登录）
    admin_username: str = "admin"
    admin_password: str = ""
    jwt_secret: str = ""
    jwt_expire_minutes: int = 60 * 24
    # 逗号分隔，如 http://localhost:5173（Vite 管理端本地开发时跨域调 API）
    cors_origins: str = ""
    # 索引时按 Git 变更增量更新向量（需已有一次成功索引并写入 last_indexed_commit；旧版 :: 序号 id 会自动全量重建）
    incremental_index: bool = False
    # 本地 Git 镜像缓存（DATA_DIR/repos）：多项目时按 LRU 删其它项目目录以控磁盘；0 表示不启用
    repos_cache_max_gb: float = 0
    repos_cache_max_count: int = 0
    # 索引时排除的仓库相对路径 glob（见 index_exclude 模块）；多行或逗号分隔；可在管理端「设置」覆盖
    index_exclude_patterns: str = ""
    audit_retention_days: int = 90

    @field_validator("index_exclude_patterns", mode="before")
    @classmethod
    def _normalize_index_exclude_patterns(cls, v: object) -> str:
        s = "" if v is None else str(v)
        if len(s) > 65536:
            s = s[:65536]
        return s

    @field_validator("content_language", mode="before")
    @classmethod
    def _normalize_content_language(cls, v: object) -> str:
        s = str(v or "en").strip().lower()
        return "en" if s.startswith("en") else "zh"

    @field_validator("embed_provider", mode="before")
    @classmethod
    def _normalize_embed_provider(cls, v: object) -> str:
        s = str(v or "ollama").strip().lower().replace("-", "_")
        if s in ("openai", "openai_compat"):
            return "openai"
        return "ollama"

    @field_validator("llm_provider", mode="before")
    @classmethod
    def _normalize_llm_provider(cls, v: object) -> str:
        s = str(v or "openai").strip().lower().replace("-", "_")
        # 历史值 auto 视为 openai
        if s in ("auto", "legacy", ""):
            return "openai"
        if s == "dify":
            return "dify"
        if s in ("azure_openai", "azure"):
            return "azure_openai"
        if s in ("openai", "openai_compat"):
            return "openai"
        return "openai"

    @field_validator("wiki_backend", mode="before")
    @classmethod
    def _normalize_wiki_backend(cls, v: object) -> str:
        s = str(v or "mkdocs").strip().lower()
        if s in ("mkdocs", "starlight", "vitepress"):
            return s
        return "mkdocs"

    @field_validator("incremental_index", mode="before")
    @classmethod
    def _normalize_incremental_index(cls, v: object) -> bool:
        if isinstance(v, bool):
            return v
        s = str(v or "").strip().lower()
        return s in ("1", "true", "yes", "on")

    @field_validator("repos_cache_max_gb", mode="before")
    @classmethod
    def _normalize_repos_cache_max_gb(cls, v: object) -> float:
        if v is None or v == "":
            return 0.0
        try:
            x = float(v)
        except (TypeError, ValueError):
            return 0.0
        return x if x > 0 else 0.0

    @field_validator("repos_cache_max_count", mode="before")
    @classmethod
    def _normalize_repos_cache_max_count(cls, v: object) -> int:
        if v is None or v == "":
            return 0
        try:
            n = int(v)
        except (TypeError, ValueError):
            return 0
        return n if n > 0 else 0

    @field_validator("embed_max_chars", mode="before")
    @classmethod
    def _normalize_embed_max_chars(cls, v: object) -> int:
        if v is None or v == "":
            return 30000
        try:
            n = int(v)
        except (TypeError, ValueError):
            return 30000
        return n if n > 0 else 30000

    @field_validator("audit_retention_days", mode="before")
    @classmethod
    def _normalize_audit_retention_days(cls, v: object) -> int:
        if v is None or v == "":
            return 90
        try:
            n = int(v)
        except (TypeError, ValueError):
            return 90
        return n if n > 0 else 90

    @property
    def data_path(self) -> Path:
        p = Path(self.data_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def repos_path(self) -> Path:
        p = self.data_path / "repos"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def chroma_path(self) -> Path:
        return self.data_path / "chroma"

    model_config = SettingsConfigDict(
        env_file=_dotenv_files(),
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
