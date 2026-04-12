"""
管理后台：基于已索引向量片段的代码问答（RAG + 与索引/ Wiki 相同的 LLM 链路）。
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.auth_ui import require_ui_session
from app.effective_settings import effective_content_language
from app.llm_client import LLMClient, get_llm_client

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_CONTEXT_CHARS = 28_000
MAX_CHUNK_CHARS = 8_000
MAX_RETRIEVAL_QUERY_CHARS = 500


class CodeChatBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=8000)
    project_id: Optional[str] = None
    top_k: int = Field(12, ge=1, le=30)


def _retrieval_rewrite_system(lang: str) -> str:
    """先由 LLM 把闲聊式问题改写成更易命中代码说明的检索用语。"""
    if (lang or "zh").lower().startswith("en"):
        return (
            "You rewrite user questions into a short search query for semantic / codebase vector retrieval.\n"
            "Rules:\n"
            "- Output ONE line only: concise keywords and phrases likely to appear in indexed code docs "
            "(APIs, modules, classes, config keys, error concepts, domain terms).\n"
            "- Keep useful English identifiers; add words from the user's language if they help match docs.\n"
            "- No explanation, no markdown, no quotes, no bullet points.\n"
            "- Max 400 characters."
        )
    return (
        "你是「检索查询改写」助手。用户问题可能是口语化或模糊的，你要输出**一行**适合向量语义检索的简短文本。\n"
        "要求：\n"
        "- 尽量包含更可能出现在代码说明里的英文标识符、包名、类名、函数名、配置项、错误码、接口路径片段、业务领域词等；"
        "必要时保留或补充中文关键词。\n"
        "- 不要解释原因，不要 Markdown，不要引号，不要分点，不要输出多行。\n"
        "- 总长度不超过 400 个字符。"
    )


def _normalize_retrieval_query(raw: str, fallback: str) -> str:
    s = (raw or "").strip()
    if s.startswith("```"):
        lines = s.split("\n")
        if len(lines) >= 3 and lines[-1].strip() == "```":
            s = "\n".join(lines[1:-1]).strip()
        else:
            s = "\n".join(lines[1:]).strip()
    line = s.split("\n")[0].strip()
    if len(line) >= 2 and line[0] == line[-1] and line[0] in "\"'「」":
        line = line[1:-1].strip()
    line = line[:MAX_RETRIEVAL_QUERY_CHARS]
    if len(line) < 2:
        return fallback
    return line


def _rewrite_retrieval_query(client: LLMClient, user_message: str, lang: str) -> str:
    """调用 LLM 得到检索用查询；失败或结果无效时返回原文。"""
    system = _retrieval_rewrite_system(lang)
    try:
        raw = client.chat(system, user_message.strip())
        q = _normalize_retrieval_query(raw, user_message.strip())
        if q != user_message.strip():
            logger.info(
                "code-chat retrieval rewrite: preview_user=%r -> preview_query=%r",
                user_message[:200],
                q[:200],
            )
        return q
    except Exception as e:
        logger.warning("code-chat retrieval rewrite failed, using raw message: %s", e)
        return user_message.strip()


def _system_prompt(lang: str) -> str:
    if (lang or "zh").lower().startswith("en"):
        return (
            "You are a senior software engineer assistant. The user's message includes retrieved "
            "snippets from indexed code documentation (vector search). These snippets may be "
            "incomplete or outdated. Answer mainly from the snippets; if they are insufficient, say so "
            "clearly and do not invent APIs or file paths. Use Markdown; use fenced code blocks when "
            "quoting from snippets."
        )
    return (
        "你是资深软件工程师助手。用户消息中的「检索片段」来自团队已向量化索引的代码说明，"
        "可能不完整或过时。请主要依据这些片段作答；若不足以回答，请明确说明，不要编造片段中未出现的接口、路径或行为。"
        "回答使用 Markdown；引用代码时使用 Markdown 围栏，且尽量来自片段原文。"
    )


def _format_hit(i: int, content: str, meta: dict[str, Any]) -> str:
    path = meta.get("path") or meta.get("file") or ""
    name = meta.get("name") or ""
    pid = meta.get("project_id") or ""
    head = f"[{i}]"
    if pid:
        head += f" project_id={pid}"
    if path:
        head += f" path={path}"
    if name:
        head += f" symbol={name}"
    return f"{head}\n{content.strip()}\n"


def _code_chat_rag(
    body: CodeChatBody,
    client: LLMClient,
) -> tuple[str, Optional[str], str, list[Any], str, str]:
    """检索改写 + 向量检索 + 拼装最终 LLM user 文本。返回 (msg, pid, retrieval_query, results, system, user_payload)。"""
    from app.vector_store import get_vector_store

    msg = body.message.strip()
    pid = (body.project_id or "").strip() or None
    lang = effective_content_language()
    retrieval_query = _rewrite_retrieval_query(client, msg, lang)

    store = get_vector_store()
    results = store.query(text=retrieval_query, project_id=pid, top_k=body.top_k)

    system = _system_prompt(lang)

    parts: list[str] = []
    total = 0
    for idx, hit in enumerate(results, start=1):
        content = (hit.get("content") or "")[:MAX_CHUNK_CHARS]
        raw_meta = hit.get("metadata") or {}
        meta = raw_meta if isinstance(raw_meta, dict) else {}
        block = _format_hit(idx, content, meta)
        if total + len(block) > MAX_CONTEXT_CHARS:
            break
        parts.append(block)
        total += len(block)

    if parts:
        context_str = "\n---\n".join(parts)
        user_payload = f"用户问题：\n{msg}\n\n---\n检索片段：\n{context_str}"
    else:
        if (lang or "zh").lower().startswith("en"):
            user_payload = (
                f"User question:\n{msg}\n\n"
                f"Search query used for vector retrieval (may be LLM-rewritten):\n{retrieval_query}\n\n"
                "Note: vector search returned no snippets from indexed documentation. "
                "Reply briefly: possible reasons (project not indexed, wording mismatch, wrong project filter) "
                "and practical next steps. Do not invent specific file paths or function names."
            )
        else:
            user_payload = (
                f"用户问题：\n{msg}\n\n"
                f"用于向量检索的查询语（可能经模型改写）：\n{retrieval_query}\n\n"
                "说明：本次在已索引的代码说明中未检索到相关片段。请简要说明可能原因（如尚未索引、描述不匹配、"
                "限定项目不对等）并给出可行建议；不要捏造具体文件路径或函数名。"
            )

    return msg, pid, retrieval_query, results, system, user_payload


@router.post("/code-chat")
def code_chat(
    body: CodeChatBody,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    client = get_llm_client()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="未配置可用的 LLM（请在设置中配置 Dify、Azure OpenAI 或 OpenAI 兼容接口）",
        )

    _msg, _pid, retrieval_query, results, system, user_payload = _code_chat_rag(body, client)

    try:
        reply = client.chat(system, user_payload)
    except Exception as e:
        logger.exception("code-chat LLM failed: %s", e)
        raise HTTPException(status_code=502, detail=f"模型调用失败：{e}") from e

    return {
        "reply": (reply or "").strip(),
        "sources": results,
        "retrieval_query": retrieval_query,
    }


def _sse_line(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False, default=str)}\n\n"


@router.post("/code-chat/stream")
def code_chat_stream(
    body: CodeChatBody,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    client = get_llm_client()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="未配置可用的 LLM（请在设置中配置 Dify、Azure OpenAI 或 OpenAI 兼容接口）",
        )

    _msg, _pid, retrieval_query, results, system, user_payload = _code_chat_rag(body, client)

    def event_gen():
        yield _sse_line(
            {
                "event": "meta",
                "retrieval_query": retrieval_query,
                "sources": results,
            }
        )
        try:
            for piece in client.chat_stream(system, user_payload):
                if piece:
                    yield _sse_line({"event": "delta", "text": piece})
            yield _sse_line({"event": "done"})
        except Exception as e:
            logger.exception("code-chat stream LLM failed: %s", e)
            yield _sse_line({"event": "error", "message": str(e)})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
