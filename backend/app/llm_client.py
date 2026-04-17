from __future__ import annotations

import json
import logging
import time
from abc import ABC, abstractmethod
from collections.abc import Iterator
from typing import Any

import httpx
from openai import AzureOpenAI

from app.audit_helpers import build_provider_audit_payload
from app.audit_repo import append_audit_event
from app.effective_settings import (
    effective_azure_openai_api_key,
    effective_azure_openai_deployment,
    effective_azure_openai_endpoint,
    effective_azure_openai_version,
    effective_dify_api_key,
    effective_dify_base_url,
    effective_llm_provider,
    effective_openai_api_key,
    effective_openai_base_url,
    effective_openai_model,
)
from app.llm_usage import record_llm_usage

logger = logging.getLogger(__name__)


def _append_llm_audit_event(
    *,
    provider: str,
    model: str,
    endpoint: str,
    feature: str,
    http_status_code: int | None,
    ok: bool,
    latency_ms: int,
    project_id: str = "",
    error_type: str = "",
    error_message: str = "",
    extra: dict[str, Any] | None = None,
) -> None:
    payload_extra: dict[str, Any] = {"feature": str(feature or "").strip(), "project_id": str(project_id or "").strip()}
    if extra:
        payload_extra.update(extra)
    append_audit_event(
        event_type="provider.llm.call",
        actor="system",
        route=endpoint,
        method="POST",
        resource_type="llm_provider",
        resource_id=str(model or provider or ""),
        status="ok" if ok else "error",
        payload=build_provider_audit_payload(
            provider=provider,
            model=model,
            endpoint=endpoint,
            http_status_code=http_status_code,
            ok=ok,
            latency_ms=latency_ms,
            error_type=error_type,
            error_message=error_message,
            extra=payload_extra,
        ),
        ip="",
        user_agent="",
    )


class LLMClient(ABC):
    @abstractmethod
    def chat(self, system: str, user: str, *, feature: str = "general", project_id: str = "") -> str:
        pass

    def chat_stream(self, system: str, user: str, *, feature: str = "general", project_id: str = "") -> Iterator[str]:
        """逐段产出模型文本；默认退化为单次 blocking 回复。"""
        yield self.chat(system, user, feature=feature, project_id=project_id)


def _estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int, total_tokens: int) -> float:
    # 仅用于趋势参考，不作为精确账单；未知模型默认 0。
    rates_per_1k: dict[str, tuple[float, float]] = {
        "gpt-4o-mini": (0.00015, 0.0006),
        "gpt-4.1-mini": (0.0004, 0.0016),
        "dify-chat": (0.0, 0.0),
    }
    key = (model or "").strip().lower()
    in_rate, out_rate = rates_per_1k.get(key, (0.0, 0.0))
    p = max(0, int(prompt_tokens or 0))
    c = max(0, int(completion_tokens or 0))
    if p == 0 and c == 0:
        # 兜底估算：没有 usage 字段时按总 token 全按输入计费。
        p = max(0, int(total_tokens or 0))
    return round((p / 1000.0) * in_rate + (c / 1000.0) * out_rate, 6)


class DifyChatClient(LLMClient):
    """Dify 对话型应用 API（chat completion）。"""

    def __init__(self, api_key: str, base_url: str):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.chat_url = f"{self.base_url}/chat-messages"

    def chat(self, system: str, user: str, *, feature: str = "general", project_id: str = "") -> str:
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
        started = time.perf_counter()
        try:
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
                _append_llm_audit_event(
                    provider="dify",
                    model="dify-chat",
                    endpoint="/chat-messages",
                    feature=feature,
                    http_status_code=r.status_code,
                    ok=True,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                    project_id=project_id,
                )
                usage = ((data.get("metadata") or {}).get("usage") or {}) if isinstance(data, dict) else {}
                prompt_tokens = usage.get("prompt_tokens") if isinstance(usage, dict) else None
                completion_tokens = usage.get("completion_tokens") if isinstance(usage, dict) else None
                total_tokens = usage.get("total_tokens") if isinstance(usage, dict) else None
                latency_ms = int((time.perf_counter() - started) * 1000)
                record_llm_usage(
                    provider="dify",
                    model="dify-chat",
                    feature=feature,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    prompt_text=query,
                    completion_text=answer,
                    success=True,
                    latency_ms=latency_ms,
                    ttfb_ms=latency_ms,
                    estimated_cost_usd=_estimate_cost_usd(
                        "dify-chat",
                        int(prompt_tokens or 0),
                        int(completion_tokens or 0),
                        int(total_tokens or 0),
                    ),
                    project_id=project_id,
                )
                return answer
        except Exception as e:
            _append_llm_audit_event(
                provider="dify",
                model="dify-chat",
                endpoint="/chat-messages",
                feature=feature,
                http_status_code=r.status_code if "r" in locals() and r is not None else None,
                ok=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                project_id=project_id,
                error_type=type(e).__name__,
                error_message=str(e),
            )
            record_llm_usage(
                provider="dify",
                model="dify-chat",
                feature=feature,
                prompt_text=query,
                completion_text="",
                success=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                project_id=project_id,
            )
            raise

    def chat_stream(self, system: str, user: str, *, feature: str = "general", project_id: str = "") -> Iterator[str]:
        st = (system or "").strip()
        query = f"{st}\n\n---\n\n{user}" if st else user
        logger.info(
            "Dify stream request: len=%s, preview=%r",
            len(query),
            query[:400],
        )
        acc_answer = ""
        usage_info: dict[str, Any] | None = None
        first_piece_ms = 0
        started = time.perf_counter()
        try:
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
                                if first_piece_ms <= 0:
                                    first_piece_ms = int((time.perf_counter() - started) * 1000)
                                yield new_part
                        if ev == "message_end":
                            meta = data.get("metadata") or {}
                            if isinstance(meta, dict):
                                u = meta.get("usage")
                                if isinstance(u, dict):
                                    usage_info = u
                            break
            prompt_tokens = (usage_info or {}).get("prompt_tokens") if usage_info else None
            completion_tokens = (usage_info or {}).get("completion_tokens") if usage_info else None
            total_tokens = (usage_info or {}).get("total_tokens") if usage_info else None
            latency_ms = int((time.perf_counter() - started) * 1000)
            _append_llm_audit_event(
                provider="dify",
                model="dify-chat",
                endpoint="/chat-messages",
                feature=feature,
                http_status_code=r.status_code if "r" in locals() and r is not None else None,
                ok=True,
                latency_ms=latency_ms,
                project_id=project_id,
                extra={"stream": True},
            )
            record_llm_usage(
                provider="dify",
                model="dify-chat",
                feature=feature,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                prompt_text=query,
                completion_text=acc_answer,
                success=True,
                latency_ms=latency_ms,
                ttfb_ms=first_piece_ms or latency_ms,
                estimated_cost_usd=_estimate_cost_usd(
                    "dify-chat",
                    int(prompt_tokens or 0),
                    int(completion_tokens or 0),
                    int(total_tokens or 0),
                ),
                project_id=project_id,
            )
        except Exception as e:
            _append_llm_audit_event(
                provider="dify",
                model="dify-chat",
                endpoint="/chat-messages",
                feature=feature,
                http_status_code=r.status_code if "r" in locals() and r is not None else None,
                ok=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                project_id=project_id,
                error_type=type(e).__name__,
                error_message=str(e),
                extra={"stream": True},
            )
            record_llm_usage(
                provider="dify",
                model="dify-chat",
                feature=feature,
                prompt_text=query,
                completion_text=acc_answer,
                success=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                ttfb_ms=first_piece_ms,
                project_id=project_id,
            )
            raise


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

    def chat(self, system: str, user: str, *, feature: str = "general", project_id: str = "") -> str:
        prompt_text = f"{system}\n\n{user}"
        started = time.perf_counter()
        try:
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
                    latency_ms = int((time.perf_counter() - started) * 1000)
                    _append_llm_audit_event(
                        provider="openai_compatible",
                        model=self.model,
                        endpoint="/chat/completions",
                        feature=feature,
                        http_status_code=r.status_code,
                        ok=True,
                        latency_ms=latency_ms,
                        project_id=project_id,
                    )
                    record_llm_usage(
                        provider="openai_compatible",
                        model=self.model,
                        feature=feature,
                        prompt_text=prompt_text,
                        completion_text="",
                        success=True,
                        latency_ms=latency_ms,
                        project_id=project_id,
                    )
                    return ""
                msg = choice.get("message") or {}
                answer = (msg.get("content") or "").strip()
                usage = data.get("usage") or {}
                prompt_tokens = usage.get("prompt_tokens") if isinstance(usage, dict) else None
                completion_tokens = usage.get("completion_tokens") if isinstance(usage, dict) else None
                total_tokens = usage.get("total_tokens") if isinstance(usage, dict) else None
                latency_ms = int((time.perf_counter() - started) * 1000)
                _append_llm_audit_event(
                    provider="openai_compatible",
                    model=self.model,
                    endpoint="/chat/completions",
                    feature=feature,
                    http_status_code=r.status_code,
                    ok=True,
                    latency_ms=latency_ms,
                    project_id=project_id,
                )
                record_llm_usage(
                    provider="openai_compatible",
                    model=self.model,
                    feature=feature,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    prompt_text=prompt_text,
                    completion_text=answer,
                    success=True,
                    latency_ms=latency_ms,
                    ttfb_ms=latency_ms,
                    estimated_cost_usd=_estimate_cost_usd(
                        self.model,
                        int(prompt_tokens or 0),
                        int(completion_tokens or 0),
                        int(total_tokens or 0),
                    ),
                    project_id=project_id,
                )
                return answer
        except Exception as e:
            _append_llm_audit_event(
                provider="openai_compatible",
                model=self.model,
                endpoint="/chat/completions",
                feature=feature,
                http_status_code=r.status_code if "r" in locals() and r is not None else None,
                ok=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                project_id=project_id,
                error_type=type(e).__name__,
                error_message=str(e),
            )
            record_llm_usage(
                provider="openai_compatible",
                model=self.model,
                feature=feature,
                prompt_text=prompt_text,
                completion_text="",
                success=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                project_id=project_id,
            )
            raise

    def chat_stream(self, system: str, user: str, *, feature: str = "general", project_id: str = "") -> Iterator[str]:
        prompt_text = f"{system}\n\n{user}"
        acc_answer = ""
        usage: dict[str, Any] | None = None
        started = time.perf_counter()
        first_piece_ms = 0
        try:
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
                    body["stream_options"] = {"include_usage": True}
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
                        if isinstance(data, dict) and isinstance(data.get("usage"), dict):
                            usage = data.get("usage")
                        choice = (data.get("choices") or [None])[0]
                        if not choice:
                            continue
                        delta = (choice.get("delta") or {}).get("content")
                        if delta:
                            piece = str(delta)
                            if first_piece_ms <= 0:
                                first_piece_ms = int((time.perf_counter() - started) * 1000)
                            acc_answer += piece
                            yield piece
            prompt_tokens = (usage or {}).get("prompt_tokens") if usage else None
            completion_tokens = (usage or {}).get("completion_tokens") if usage else None
            total_tokens = (usage or {}).get("total_tokens") if usage else None
            latency_ms = int((time.perf_counter() - started) * 1000)
            _append_llm_audit_event(
                provider="openai_compatible",
                model=self.model,
                endpoint="/chat/completions",
                feature=feature,
                http_status_code=r.status_code if "r" in locals() and r is not None else None,
                ok=True,
                latency_ms=latency_ms,
                project_id=project_id,
                extra={"stream": True},
            )
            record_llm_usage(
                provider="openai_compatible",
                model=self.model,
                feature=feature,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                prompt_text=prompt_text,
                completion_text=acc_answer,
                success=True,
                latency_ms=latency_ms,
                ttfb_ms=first_piece_ms or latency_ms,
                estimated_cost_usd=_estimate_cost_usd(
                    self.model,
                    int(prompt_tokens or 0),
                    int(completion_tokens or 0),
                    int(total_tokens or 0),
                ),
                project_id=project_id,
            )
        except Exception as e:
            _append_llm_audit_event(
                provider="openai_compatible",
                model=self.model,
                endpoint="/chat/completions",
                feature=feature,
                http_status_code=r.status_code if "r" in locals() and r is not None else None,
                ok=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                project_id=project_id,
                error_type=type(e).__name__,
                error_message=str(e),
                extra={"stream": True},
            )
            record_llm_usage(
                provider="openai_compatible",
                model=self.model,
                feature=feature,
                prompt_text=prompt_text,
                completion_text=acc_answer,
                success=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                ttfb_ms=first_piece_ms,
                project_id=project_id,
            )
            raise


class AzureOpenAISDKClient(LLMClient):
    """使用官方 openai 包内的 AzureOpenAI SDK，用于生成功能说明。"""

    def __init__(self, api_key: str, endpoint: str, api_version: str, deployment: str):
        self._client = AzureOpenAI(
            api_key=api_key,
            azure_endpoint=endpoint.rstrip("/"),
            api_version=api_version,
        )
        self.deployment = deployment

    def chat(self, system: str, user: str, *, feature: str = "general", project_id: str = "") -> str:
        # gpt-5 等新模型用 max_completion_tokens，通过 extra_body 传入（SDK 可能未声明该参数）
        prompt_text = f"{system}\n\n{user}"
        try:
            logger.info(
                "AzureOpenAI request: deployment=%s, user_len=%s, user_preview=%r",
                self.deployment,
                len(user or ""),
                (user or "")[:400],
            )
        except Exception:
            pass
        started = time.perf_counter()
        try:
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
                record_llm_usage(
                    provider="azure_openai",
                    model=self.deployment,
                    feature=feature,
                    prompt_text=prompt_text,
                    completion_text="",
                    success=True,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                    project_id=project_id,
                )
                return ""
            answer = (choice.message.content or "").strip()
            u = getattr(resp, "usage", None)
            latency_ms = int((time.perf_counter() - started) * 1000)
            _append_llm_audit_event(
                provider="azure_openai",
                model=self.deployment,
                endpoint="azure.chat.completions",
                feature=feature,
                http_status_code=200,
                ok=True,
                latency_ms=latency_ms,
                project_id=project_id,
            )
            prompt_tokens = int(getattr(u, "prompt_tokens", 0)) if u is not None and getattr(u, "prompt_tokens", None) is not None else None
            completion_tokens = int(getattr(u, "completion_tokens", 0)) if u is not None and getattr(u, "completion_tokens", None) is not None else None
            total_tokens = int(getattr(u, "total_tokens", 0)) if u is not None and getattr(u, "total_tokens", None) is not None else None
            record_llm_usage(
                provider="azure_openai",
                model=self.deployment,
                feature=feature,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                prompt_text=prompt_text,
                completion_text=answer,
                success=True,
                latency_ms=latency_ms,
                ttfb_ms=latency_ms,
                estimated_cost_usd=_estimate_cost_usd(
                    self.deployment,
                    int(prompt_tokens or 0),
                    int(completion_tokens or 0),
                    int(total_tokens or 0),
                ),
                project_id=project_id,
            )
            return answer
        except Exception as e:
            _append_llm_audit_event(
                provider="azure_openai",
                model=self.deployment,
                endpoint="azure.chat.completions",
                feature=feature,
                http_status_code=None,
                ok=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                project_id=project_id,
                error_type=type(e).__name__,
                error_message=str(e),
            )
            record_llm_usage(
                provider="azure_openai",
                model=self.deployment,
                feature=feature,
                prompt_text=prompt_text,
                completion_text="",
                success=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                project_id=project_id,
            )
            raise

    def chat_stream(self, system: str, user: str, *, feature: str = "general", project_id: str = "") -> Iterator[str]:
        prompt_text = f"{system}\n\n{user}"
        acc_answer = ""
        started = time.perf_counter()
        first_piece_ms = 0
        try:
            logger.info(
                "AzureOpenAI stream: deployment=%s, user_len=%s",
                self.deployment,
                len(user or ""),
            )
        except Exception:
            pass
        try:
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
                    text = str(piece)
                    if first_piece_ms <= 0:
                        first_piece_ms = int((time.perf_counter() - started) * 1000)
                    acc_answer += text
                    yield text
            latency_ms = int((time.perf_counter() - started) * 1000)
            _append_llm_audit_event(
                provider="azure_openai",
                model=self.deployment,
                endpoint="azure.chat.completions",
                feature=feature,
                http_status_code=200,
                ok=True,
                latency_ms=latency_ms,
                project_id=project_id,
                extra={"stream": True},
            )
            record_llm_usage(
                provider="azure_openai",
                model=self.deployment,
                feature=feature,
                prompt_text=prompt_text,
                completion_text=acc_answer,
                success=True,
                latency_ms=latency_ms,
                ttfb_ms=first_piece_ms,
                project_id=project_id,
            )
        except Exception as e:
            _append_llm_audit_event(
                provider="azure_openai",
                model=self.deployment,
                endpoint="azure.chat.completions",
                feature=feature,
                http_status_code=None,
                ok=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                project_id=project_id,
                error_type=type(e).__name__,
                error_message=str(e),
                extra={"stream": True},
            )
            record_llm_usage(
                provider="azure_openai",
                model=self.deployment,
                feature=feature,
                prompt_text=prompt_text,
                completion_text=acc_answer,
                success=False,
                latency_ms=int((time.perf_counter() - started) * 1000),
                ttfb_ms=first_piece_ms,
                project_id=project_id,
            )
            raise


_cached_client: LLMClient | None = None


def reset_llm_client_cache() -> None:
    global _cached_client
    _cached_client = None


def _try_dify_client() -> LLMClient | None:
    dify_key = effective_dify_api_key()
    dify_url = effective_dify_base_url()
    if dify_key and dify_url:
        return DifyChatClient(dify_key, dify_url)
    return None


def _try_azure_client() -> LLMClient | None:
    az_key = effective_azure_openai_api_key()
    az_ep = effective_azure_openai_endpoint()
    if az_key and az_ep:
        version = effective_azure_openai_version() or "2024-05-01-preview"
        deployment = effective_azure_openai_deployment() or "gpt-4o-mini"
        return AzureOpenAISDKClient(az_key, az_ep, version, deployment)
    return None


def _try_openai_client() -> LLMClient | None:
    oa_key = effective_openai_api_key()
    if oa_key:
        base = effective_openai_base_url() or "https://api.openai.com/v1"
        return OpenAICompatibleClient(oa_key, base, model=effective_openai_model())
    return None


def get_llm_client() -> LLMClient | None:
    global _cached_client
    if _cached_client is not None:
        return _cached_client
    provider = effective_llm_provider()
    if provider == "dify":
        _cached_client = _try_dify_client()
        return _cached_client
    if provider == "azure_openai":
        _cached_client = _try_azure_client()
        return _cached_client
    _cached_client = _try_openai_client()
    return _cached_client


def precheck_llm_connectivity() -> tuple[bool, str]:
    """按 llm_provider 检查对应 LLM 是否可达（与 get_llm_client 选型一致）。"""
    provider = effective_llm_provider()

    def check_dify() -> tuple[bool, str]:
        dify_key = (effective_dify_api_key() or "").strip()
        dify_base = (effective_dify_base_url() or "").strip().rstrip("/")
        if not dify_key or not dify_base:
            return False, "已选择 Dify，但未配置 DIFY_API_KEY 或 DIFY_BASE_URL"
        try:
            with httpx.Client(timeout=20.0) as client:
                r = client.get(dify_base)
                if r.status_code < 500:
                    return True, "Dify 可达"
                return False, f"Dify HTTP {r.status_code}"
        except Exception as e:  # noqa: S110
            return False, str(e)

    def check_azure() -> tuple[bool, str]:
        az_key = (effective_azure_openai_api_key() or "").strip()
        az_ep = (effective_azure_openai_endpoint() or "").strip().rstrip("/")
        if not az_key or not az_ep:
            return False, "已选择 Azure OpenAI，但未配置密钥或 Endpoint"
        version = (effective_azure_openai_version() or "2024-05-01-preview").strip()
        url = f"{az_ep}/openai/deployments?api-version={version}"
        try:
            with httpx.Client(timeout=20.0) as client:
                r = client.get(url, headers={"api-key": az_key})
                if r.status_code < 400:
                    return True, "Azure OpenAI 可达"
                return False, f"Azure OpenAI HTTP {r.status_code}"
        except Exception as e:  # noqa: S110
            return False, str(e)

    def check_openai() -> tuple[bool, str]:
        oa_key = (effective_openai_api_key() or "").strip()
        oa_base = (effective_openai_base_url() or "https://api.openai.com/v1").strip().rstrip("/")
        if not oa_key:
            return False, "已选择 OpenAI 兼容，但未配置 OPENAI_API_KEY"
        try:
            with httpx.Client(timeout=20.0) as client:
                r = client.get(f"{oa_base}/models", headers={"Authorization": f"Bearer {oa_key}"})
                if r.status_code < 400:
                    return True, "OpenAI 兼容接口可达"
                return False, f"OpenAI 兼容接口 HTTP {r.status_code}"
        except Exception as e:  # noqa: S110
            return False, str(e)

    if provider == "dify":
        return check_dify()
    if provider == "azure_openai":
        return check_azure()
    # openai：无 API Key 时视为未启用 LLM，不阻塞索引预检
    oa_key = (effective_openai_api_key() or "").strip()
    if not oa_key:
        return True, "未配置 OPENAI_API_KEY（LLM 可选）"
    return check_openai()
