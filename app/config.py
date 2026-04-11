from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gitlab_webhook_secret: str = ""
    gitlab_access_token: str = ""
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
    # 索引成功后是否生成 MkDocs 静态 Wiki（见 README）
    wiki_enabled: bool = True
    wiki_max_file_pages: int = 5000
    wiki_symbol_rows_per_file: int = 4000

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

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
