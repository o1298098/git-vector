from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from collections.abc import Iterator
from typing import Any

import httpx
from openai import AzureOpenAI

from app.effective_settings import (
    effective_azure_openai_api_key,
    effective_azure_openai_deployment,
    effective_azure_openai_endpoint,
    effective_azure_openai_version,
    effective_dify_api_key,
    effective_dify_base_url,
    effective_openai_api_key,
    effective_openai_base_url,
    effective_openai_model,
)

logger = logging.getLogger(__name__)


class LLMClient(ABC):
    @abstractmethod
    def chat(self, system: str, user: str) -> str:
        pass

    def chat_stream(self, system: str, user: str) -> Iterator[str]:
        """逐段产出模型文本；默认退化为单次 blocking 回复。"""
        yield self.chat(system, user)


class DifyChatClient(LLMClient):
    """Dify 对话型应用 API（chat completion）。"""

    def __init__(self, api_key: str, base_url: str):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.chat_url = f"{self.base_url}/chat-messages"

    def chat(self, system: str, user: str) -> str:
        # 与 Dify 官方示例一致：blocking 模式取完整 answer。对话型应用无独立 system 字段时，
        # 将 system 与 user 拼入 query，避免指令与 RAG 说明被丢弃。
        st = (system or "").strip()
        query = f"{st}\n\n---\n\n{user}" if st else user
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

    def chat_stream(self, system: str, user: str) -> Iterator[str]:
        st = (system or "").strip()
        query = f"{st}\n\n---\n\n{user}" if st else user
        logger.info(
            "Dify stream request: len=%s, preview=%r",
            len(query),
            query[:400],
        )
        with httpx.Client(timeout=120) as client:
            with client.stream(
                "POST",
                self.chat_url,
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={
                    "inputs": {},
                    "query": query,
                    "response_mode": "streaming",
                    "conversation_id": "",
                    "user": "gitlab-vetor-indexer",
                },
            ) as r:
                if r.status_code == 400:
                    try:
                        logger.warning("Dify stream 400 (url=%s): %s", self.chat_url, r.text[:500])
                    except Exception:
                        pass
                r.raise_for_status()
                acc_answer = ""
                for line in r.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw:
                        continue
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    ev = data.get("event")
                    if ev == "error":
                        msg = data.get("message") or data.get("code") or str(data)
                        raise RuntimeError(f"Dify stream error: {msg}")
                    if ev == "message" and data.get("answer"):
                        cur = str(data["answer"])
                        # Dify 部分版本为增量片段，部分为累计全文：两种都兼容
                        if acc_answer and cur.startswith(acc_answer):
                            new_part = cur[len(acc_answer) :]
                            acc_answer = cur
                        else:
                            new_part = cur
                            acc_answer = acc_answer + cur
                        if new_part:
                            yield new_part
                    if ev == "message_end":
                        break


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

    def chat_stream(self, system: str, user: str) -> Iterator[str]:
        with httpx.Client(timeout=120) as client:
            body: dict[str, Any] = {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "stream": True,
            }
            if self.use_azure_header:
                body["max_completion_tokens"] = 4096
            else:
                body["max_tokens"] = 4096
            try:
                logger.info(
                    "OpenAI-compatible stream: model=%s, user_len=%s",
                    self.model,
                    len(user or ""),
                )
            except Exception:
                pass
            with client.stream("POST", self.chat_url, headers=self._headers(), json=body) as r:
                if r.status_code == 400:
                    try:
                        logger.warning("OpenAI-compatible stream 400: %s", r.text[:400])
                    except Exception:
                        pass
                r.raise_for_status()
                for line in r.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    choice = (data.get("choices") or [None])[0]
                    if not choice:
                        continue
                    delta = (choice.get("delta") or {}).get("content")
                    if delta:
                        yield str(delta)


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

    def chat_stream(self, system: str, user: str) -> Iterator[str]:
        try:
            logger.info(
                "AzureOpenAI stream: deployment=%s, user_len=%s",
                self.deployment,
                len(user or ""),
            )
        except Exception:
            pass
        stream = self._client.chat.completions.create(
            model=self.deployment,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            stream=True,
            extra_body={"max_completion_tokens": 4096},
        )
        for chunk in stream:
            if not chunk.choices:
                continue
            c0 = chunk.choices[0]
            if not c0.delta or c0.delta.content is None:
                continue
            piece = c0.delta.content
            if piece:
                yield str(piece)


_cached_client: LLMClient | None = None


def reset_llm_client_cache() -> None:
    global _cached_client
    _cached_client = None


def get_llm_client() -> LLMClient | None:
    global _cached_client
    if _cached_client is not None:
        return _cached_client
    dify_key = effective_dify_api_key()
    dify_url = effective_dify_base_url()
    if dify_key and dify_url:
        _cached_client = DifyChatClient(dify_key, dify_url)
        return _cached_client
    # Azure OpenAI：优先使用官方 SDK
    az_key = effective_azure_openai_api_key()
    az_ep = effective_azure_openai_endpoint()
    if az_key and az_ep:
        version = effective_azure_openai_version() or "2024-05-01-preview"
        deployment = effective_azure_openai_deployment() or "gpt-4o-mini"
        _cached_client = AzureOpenAISDKClient(
            az_key,
            az_ep,
            version,
            deployment,
        )
        return _cached_client
    oa_key = effective_openai_api_key()
    if oa_key:
        base = effective_openai_base_url() or "https://api.openai.com/v1"
        _cached_client = OpenAICompatibleClient(
            oa_key, base, model=effective_openai_model()
        )
        return _cached_client
    return None
