from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any

import httpx
from openai import AzureOpenAI

from app.config import settings

logger = logging.getLogger(__name__)


class LLMClient(ABC):
    @abstractmethod
    def chat(self, system: str, user: str) -> str:
        pass


class DifyChatClient(LLMClient):
    """Dify 对话型应用 API（chat completion）。"""

    def __init__(self, api_key: str, base_url: str):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.chat_url = f"{self.base_url}/chat-messages"

    def chat(self, system: str, user: str) -> str:
        # 与 Dify 官方示例一致：只把用户内容放在 query，response_mode 用 blocking 以拿到完整回复。
        # 上层（analyzer 等）已经对单次请求长度做了控制，这里不再强行截断，避免代码上下文被截断。
        query = user
        # 记录缩略请求体，便于排查 LLM 调用是否正常（只打印前 400 字符）
        logger.info(
            "Dify request: len=%s, preview=%r",
            len(query),
            query[:400],
        )
        with httpx.Client(timeout=120) as client:
            r = client.post(
                self.chat_url,
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={
                    "inputs": {},
                    "query": query,
                    "response_mode": "blocking",
                    "conversation_id": "",
                    "user": "gitlab-vetor-indexer",
                },
            )
            if r.status_code == 400:
                try:
                    body = r.text[:500] if r.text else ""
                    logger.warning("Dify 400 BAD REQUEST (url=%s): %s", self.chat_url, body)
                except Exception:
                    pass
            r.raise_for_status()
            data = r.json()
            answer = (data.get("answer") or "").strip()
            return answer


class OpenAICompatibleClient(LLMClient):
    """OpenAI 兼容 API（含 Azure OpenAI），用于生成功能说明。"""

    def __init__(self, api_key: str, base_url: str, model: str = "gpt-4o-mini", use_azure_header: bool = False):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.chat_url = (
            self.base_url
            if "chat/completions" in self.base_url
            else f"{self.base_url}/chat/completions"
        )
        self.model = model
        self.use_azure_header = use_azure_header

    def _headers(self) -> dict[str, str]:
        if self.use_azure_header:
            return {"api-key": self.api_key, "Content-Type": "application/json"}
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def chat(self, system: str, user: str) -> str:
        with httpx.Client(timeout=120) as client:
            body: dict[str, Any] = {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            }
            # 记录缩略请求体
            try:
                user_preview = (user or "")[:400]
                logger.info(
                    "OpenAI-compatible request: model=%s, user_len=%s, user_preview=%r",
                    self.model,
                    len(user or ""),
                    user_preview,
                )
            except Exception:
                pass
            # 新版本 Azure 模型用 max_completion_tokens，旧版用 max_tokens
            if self.use_azure_header:
                body["max_completion_tokens"] = 4096
            else:
                body["max_tokens"] = 4096
            r = client.post(self.chat_url, headers=self._headers(), json=body)
            if r.status_code == 400:
                try:
                    logger.warning("OpenAI/Azure 400: %s", r.text[:400])
                except Exception:
                    pass
            r.raise_for_status()
            data = r.json()
            choice = (data.get("choices") or [None])[0]
            if not choice:
                return ""
            msg = choice.get("message") or {}
            return (msg.get("content") or "").strip()


class AzureOpenAISDKClient(LLMClient):
    """使用官方 openai 包内的 AzureOpenAI SDK，用于生成功能说明。"""

    def __init__(self, api_key: str, endpoint: str, api_version: str, deployment: str):
        self._client = AzureOpenAI(
            api_key=api_key,
            azure_endpoint=endpoint.rstrip("/"),
            api_version=api_version,
        )
        self.deployment = deployment

    def chat(self, system: str, user: str) -> str:
        # gpt-5 等新模型用 max_completion_tokens，通过 extra_body 传入（SDK 可能未声明该参数）
        try:
            logger.info(
                "AzureOpenAI request: deployment=%s, user_len=%s, user_preview=%r",
                self.deployment,
                len(user or ""),
                (user or "")[:400],
            )
        except Exception:
            pass
        resp = self._client.chat.completions.create(
            model=self.deployment,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            extra_body={"max_completion_tokens": 4096},
        )
        choice = (resp.choices or [None])[0]
        if not choice or not choice.message:
            return ""
        return (choice.message.content or "").strip()


_cached_client: LLMClient | None = None


def get_llm_client() -> LLMClient | None:
    global _cached_client
    if _cached_client is not None:
        return _cached_client
    if settings.dify_api_key and settings.dify_base_url:
        _cached_client = DifyChatClient(settings.dify_api_key, settings.dify_base_url)
        return _cached_client
    # Azure OpenAI：优先使用官方 SDK
    if settings.azure_openai_api_key and settings.azure_openai_endpoint:
        version = settings.azure_openai_version or "2024-05-01-preview"
        deployment = settings.azure_openai_deployment or "gpt-4o-mini"
        _cached_client = AzureOpenAISDKClient(
            settings.azure_openai_api_key,
            settings.azure_openai_endpoint,
            version,
            deployment,
        )
        return _cached_client
    if settings.openai_api_key:
        base = settings.openai_base_url or "https://api.openai.com/v1"
        _cached_client = OpenAICompatibleClient(
            settings.openai_api_key, base, model=settings.openai_model
        )
        return _cached_client
    return None
