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
    # 优先于 GITLAB_ACCESS_TOKEN：任意 Git 托管的 HTTPS 克隆令牌（PAT 等）
    git_https_token: str = ""
    # HTTPS 克隆时的用户名；默认 oauth2（GitLab）；GitHub 常用 x-access-token
    git_https_username: str = ""
    # 概览「打开仓库」无任务记录时的兜底：与 project_id（path/with/namespace）拼接，如 https://gitlab.com
    gitlab_external_url: str = ""
    # 索引 / Wiki 中 LLM 生成说明的语言：zh | en（默认中文）
    content_language: str = "zh"
    dify_api_key: str = ""
    dify_base_url: str = "https://api.dify.ai/v1"
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o-mini"  # OpenAI 为模型名；Azure 填部署名
    # Azure OpenAI（优先于 OPENAI_* 使用，需同时填 endpoint + key + version + deployment）
    azure_openai_api_key: str = ""
    azure_openai_endpoint: str = ""
    azure_openai_version: str = "2024-05-01-preview"
    azure_openai_deployment: str = "gpt-4o-mini"  # 部署名，与 Azure 门户中一致
    data_dir: str = "./data"
    # 文本嵌入模型（需为 fastembed TextEmbedding 支持列表中的模型，如 intfloat/multilingual-e5-large）
    embed_model: str = "intfloat/multilingual-e5-large"
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

    @field_validator("content_language", mode="before")
    @classmethod
    def _normalize_content_language(cls, v: object) -> str:
        s = str(v or "zh").strip().lower()
        return "en" if s.startswith("en") else "zh"

    @field_validator("wiki_backend", mode="before")
    @classmethod
    def _normalize_wiki_backend(cls, v: object) -> str:
        s = str(v or "mkdocs").strip().lower()
        if s in ("mkdocs", "starlight", "vitepress"):
            return s
        return "mkdocs"

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
