"""
管理后台：基于已索引向量片段的代码问答（RAG + 与索引/ Wiki 相同的 LLM 链路）。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.auth_ui import require_ui_session
from app.api_errors import raise_app_error
from app.effective_settings import effective_content_language
from app.llm_client import LLMClient, get_llm_client

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_CONTEXT_CHARS = 28_000
MAX_CHUNK_CHARS = 8_000
MAX_RETRIEVAL_QUERY_CHARS = 500
MAX_HISTORY_TURNS = 16
MAX_HISTORY_TURN_CHARS = 3_000
MAX_HISTORY_CHARS = 10_000

ChatIntent = Literal["code_qa", "chitchat", "product_help", "admin_ops", "unknown"]
AdminIntent = Literal["audit_help", "settings_help", "jobs_help", "vectors_help", "usage_help", "enqueue_help", "search_help", "chat_help", "admin_general"]
_PRODUCT_HELP_KEYWORDS = (
    "你能做什么",
    "可以做什么",
    "有哪些功能",
    "支持什么",
    "怎么用",
    "如何使用",
    "能帮我做什么",
    "what can you do",
    "what do you do",
    "what can this system do",
)
_ADMIN_OPS_KEYWORDS = (
    "页面在哪",
    "怎么查看",
    "在哪看",
    "在哪管理",
    "where is",
    "how to view",
    "how to manage",
    "open the",
    "go to the",
)
_CHITCHAT_EXACT = {
    "你好",
    "您好",
    "嗨",
    "hi",
    "hello",
    "hey",
    "早上好",
    "下午好",
    "晚上好",
    "谢谢",
    "多谢",
    "thank you",
    "thanks",
    "你是谁",
    "who are you",
}
_CODE_HINT_KEYWORDS = (
    "代码",
    "函数",
    "类",
    "接口",
    "模块",
    "仓库",
    "实现",
    "报错",
    "错误",
    "调用",
    "逻辑",
    "源码",
    "功能",
    "feature",
    "有没有",
    "是否有",
    "支持",
    "存在",
    "项目中",
    "仓库里",
    "这个项目",
    "file",
    "function",
    "class",
    "module",
    "api",
    "endpoint",
    "implementation",
    "source code",
)
_ADMIN_SUBINTENT_KEYWORDS: tuple[tuple[AdminIntent, tuple[str, ...]], ...] = (
    ("audit_help", ("审计", "日志", "audit", "log")),
    ("settings_help", ("设置", "配置", "settings", "config")),
    ("jobs_help", ("任务", "索引任务", "jobs", "job", "index job")),
    ("vectors_help", ("向量", "向量管理", "vectors", "vector")),
    ("usage_help", ("用量", "token", "usage", "llm 用量")),
    ("enqueue_help", ("新建索引", "入队", "enqueue", "添加仓库", "重建索引")),
    ("search_help", ("检索", "搜索", "search", "语义检索")),
    ("chat_help", ("问答", "聊天", "chat", "代码问答")),
)


class CodeChatHistoryTurn(BaseModel):
    role: str = Field(..., min_length=1, max_length=32)
    content: str = Field(..., min_length=1, max_length=MAX_HISTORY_TURN_CHARS)


class CodeChatBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=8000)
    project_id: Optional[str] = None
    top_k: int = Field(12, ge=1, le=30)
    history: list[CodeChatHistoryTurn] = Field(default_factory=list, max_length=MAX_HISTORY_TURNS)


class CodeChatFeedbackBody(BaseModel):
    rating: int = Field(..., ge=-1, le=1)
    reason: str = Field(default="", max_length=500)
    project_id: Optional[str] = None


def _output_language_name(lang: str) -> str:
    return "English" if (lang or "zh").lower().startswith("en") else "Simplified Chinese"


def _reply_language_instruction(lang: str) -> str:
    return f"Reply in {_output_language_name(lang)}."


def _retrieval_rewrite_system(lang: str) -> str:
    """先由 LLM 把闲聊式问题改写成更易命中代码说明的检索用语。"""
    return (
        "You rewrite user questions into a short search query for semantic / codebase vector retrieval.\n"
        "Rules:\n"
        "- Output ONE line only: concise keywords and phrases likely to appear in indexed code docs "
        "(APIs, modules, classes, config keys, error concepts, domain terms).\n"
        "- Keep useful English identifiers; add words from the user's language if they help match docs.\n"
        "- No explanation, no markdown, no quotes, no bullet points.\n"
        "- Max 400 characters.\n"
        f"- The single-line output should be in {_output_language_name(lang)} when natural language terms are needed."
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
        raw = client.chat(system, user_message.strip(), feature="code_chat_rewrite")
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
    return (
        "You are a senior software engineer assistant. The user's message includes retrieved "
        "snippets from indexed code documentation (vector search). These snippets may be "
        "incomplete or outdated. Answer mainly from the snippets; if they are insufficient, say so "
        "clearly and do not invent APIs or file paths. Use Markdown; use fenced code blocks when "
        "quoting from snippets. "
        + _reply_language_instruction(lang)
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


def _normalize_history_turns(history: list[CodeChatHistoryTurn]) -> list[tuple[str, str]]:
    """只保留 user/assistant 两类，按总长度裁剪，避免请求体过大。"""
    kept: list[tuple[str, str]] = []
    total = 0
    for item in history:
        role_raw = (item.role or "").strip().lower()
        if role_raw not in ("user", "assistant"):
            continue
        content = (item.content or "").strip()
        if not content:
            continue
        content = content[:MAX_HISTORY_TURN_CHARS]
        part = f"{role_raw}:{content}\n"
        if total + len(part) > MAX_HISTORY_CHARS:
            continue
        kept.append((role_raw, content))
        total += len(part)
    return kept


def _history_block(lang: str, history: list[CodeChatHistoryTurn]) -> str:
    normalized = _normalize_history_turns(history)
    if not normalized:
        return ""
    lines = []
    for role, content in normalized:
        speaker = "User" if role == "user" else "Assistant"
        lines.append(f"{speaker}:\n{content}")
    joined = "\n\n".join(lines)
    return f"Recent conversation context:\n{joined}"


def _normalize_intent_label(raw: str) -> ChatIntent:
    s = (raw or "").strip().lower().replace("-", "_")
    if s in ("code_qa", "code", "rag"):
        return "code_qa"
    if s in ("chitchat", "smalltalk", "chat"):
        return "chitchat"
    if s in ("product_help", "product", "help", "capability"):
        return "product_help"
    if s in ("admin_ops", "admin", "ops", "operation"):
        return "admin_ops"
    return "unknown"


def _contains_any(text: str, keywords: tuple[str, ...]) -> bool:
    return any(k in text for k in keywords)


def _detect_chat_intent_by_rules(message: str) -> ChatIntent | None:
    text = re.sub(r"\s+", " ", (message or "").strip().lower())
    if not text:
        return "unknown"
    if text in _CHITCHAT_EXACT:
        return "chitchat"
    if _contains_any(text, _CODE_HINT_KEYWORDS):
        return "code_qa"
    if _contains_any(text, _ADMIN_OPS_KEYWORDS):
        return "admin_ops"
    if _contains_any(text, _PRODUCT_HELP_KEYWORDS):
        return "product_help"
    return None


def _intent_classifier_system(lang: str) -> str:
    return (
        "Classify the user's latest message into exactly one label: "
        "code_qa, chitchat, product_help, admin_ops, unknown.\n"
        "Definitions:\n"
        "- code_qa: asking about repository code, implementation, APIs, config behavior, errors, logic.\n"
        "- chitchat: greetings, thanks, identity, casual social talk.\n"
        "- product_help: asking what this system can do, how to use it, product capabilities.\n"
        "- admin_ops: asking where to view or manage jobs, settings, audit, vectors, usage in the admin UI.\n"
        "- unknown: cannot tell confidently.\n"
        f"Understand the user message in {_output_language_name(lang)} if needed.\n"
        "Output only the label."
    )


def _detect_chat_intent_by_llm(client: LLMClient, message: str, lang: str) -> ChatIntent:
    try:
        raw = client.chat(_intent_classifier_system(lang), message.strip(), feature="code_chat_intent")
        return _normalize_intent_label(raw)
    except Exception as e:
        logger.warning("code-chat intent classify failed: %s", e)
        return "unknown"


def detect_chat_intent(client: LLMClient, body: CodeChatBody) -> ChatIntent:
    msg = (body.message or "").strip()
    by_rule = _detect_chat_intent_by_rules(msg)
    if by_rule is not None:
        return by_rule
    return _detect_chat_intent_by_llm(client, msg, effective_content_language())


def _product_help_system(lang: str) -> str:
    return (
        "You are the Git Vector admin console assistant. Answer briefly and concretely about product capabilities. "
        "This system supports repository indexing, semantic search, code chat, jobs, audit logs, vector management, usage statistics, and settings. "
        "Do not invent unsupported features. "
        + _reply_language_instruction(lang)
    )


def _admin_subintent(message: str) -> AdminIntent:
    text = re.sub(r"\s+", " ", (message or "").strip().lower())
    for intent, keywords in _ADMIN_SUBINTENT_KEYWORDS:
        if _contains_any(text, keywords):
            return intent
    return "admin_general"


def _admin_ops_system(lang: str, subintent: AdminIntent) -> str:
    guides = {
        "audit_help": "Guide the user to the Audit page to inspect event logs, provider calls, status codes, latency, and errors.",
        "settings_help": "Guide the user to the Settings page to adjust providers, model configuration, audit retention, and system options.",
        "jobs_help": "Guide the user to the Jobs page to monitor indexing queue, progress, retry, and cancellation.",
        "vectors_help": "Guide the user to the Vectors page to inspect vectorized content and related retrieval data.",
        "usage_help": "Guide the user to the Usage page to inspect LLM usage statistics and token consumption.",
        "enqueue_help": "Guide the user to the New Index page to enqueue a repository or trigger a new indexing flow.",
        "search_help": "Guide the user to the Search page for semantic retrieval over indexed repositories.",
        "chat_help": "Guide the user to the Chat page for code Q&A grounded in indexed snippets.",
        "admin_general": "Guide the user to the most relevant admin page among Search, Chat, Jobs, Usage, Vectors, Audit, Enqueue, Settings.",
    }
    return (
        "You are the Git Vector admin console assistant. The user is asking how to operate the admin UI. "
        "Do not claim you executed actions. Only guide the user to the right page, explain what can be done there, and suggest the next click. "
        + guides[subintent]
        + " "
        + _reply_language_instruction(lang)
    )


def _direct_chat_system(lang: str) -> str:
    return (
        "You are a concise and friendly assistant. Reply naturally without mentioning retrieval or indexed snippets. "
        + _reply_language_instruction(lang)
    )


def _handle_direct_chat(client: LLMClient, body: CodeChatBody, *, intent: ChatIntent) -> tuple[str, Optional[str], str, list[Any], str, str, ChatIntent]:
    msg = body.message.strip()
    pid = (body.project_id or "").strip() or None
    lang = effective_content_language()
    if intent == "product_help":
        system = _product_help_system(lang)
        user_payload = msg
    elif intent == "admin_ops":
        subintent = _admin_subintent(msg)
        system = _admin_ops_system(lang, subintent)
        user_payload = msg
    else:
        system = _direct_chat_system(lang)
        user_payload = msg
    return msg, pid, "", [], system, user_payload, intent


def route_chat_request(
    body: CodeChatBody,
    client: LLMClient,
) -> tuple[str, Optional[str], str, list[Any], str, str, ChatIntent]:
    intent = detect_chat_intent(client, body)
    if intent in ("code_qa", "unknown"):
        msg, pid, retrieval_query, results, system, user_payload = _code_chat_rag(body, client)
        return msg, pid, retrieval_query, results, system, user_payload, intent
    return _handle_direct_chat(client, body, intent=intent)


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
    history_block = _history_block(lang, body.history)

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
        user_payload = (
            (f"{history_block}\n\n---\n" if history_block else "")
            + f"User question:\n{msg}\n\n---\nRetrieved snippets:\n{context_str}"
        )
    else:
        user_payload = (
            (f"{history_block}\n\n---\n" if history_block else "")
            + f"User question:\n{msg}\n\n"
            f"Search query used for vector retrieval (may be LLM-rewritten):\n{retrieval_query}\n\n"
            "Note: vector search returned no snippets from indexed documentation. "
            "Reply briefly: possible reasons (project not indexed, wording mismatch, wrong project filter) "
            "and practical next steps. Do not invent specific file paths or function names."
        )

    return msg, pid, retrieval_query, results, system, user_payload


@router.post("/code-chat")
def code_chat(
    body: CodeChatBody,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    client = get_llm_client()
    if client is None:
        raise_app_error(
            status_code=503,
            code="LLM_UNAVAILABLE",
            message="未配置可用的 LLM",
            hint="请在设置中配置 Dify、Azure OpenAI 或 OpenAI 兼容接口。",
            retryable=False,
        )

    _msg, pid, retrieval_query, results, system, user_payload, intent = route_chat_request(body, client)

    try:
        reply = client.chat(system, user_payload, feature="code_chat_answer", project_id=pid or "")
    except Exception as e:
        logger.exception("code-chat LLM failed: %s", e)
        raise_app_error(
            status_code=502,
            code="UPSTREAM_LLM_FAILED",
            message="模型调用失败",
            hint="请稍后重试，若持续失败请检查上游 LLM 服务状态。",
            retryable=True,
            extra={"detail": str(e)[:500]},
        )

    return {
        "reply": (reply or "").strip(),
        "sources": results,
        "retrieval_query": retrieval_query,
        "intent": intent,
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
        raise_app_error(
            status_code=503,
            code="LLM_UNAVAILABLE",
            message="未配置可用的 LLM",
            hint="请在设置中配置 Dify、Azure OpenAI 或 OpenAI 兼容接口。",
            retryable=False,
        )

    _msg, pid, retrieval_query, results, system, user_payload, intent = route_chat_request(body, client)

    def event_gen():
        yield _sse_line(
            {
                "event": "meta",
                "intent": intent,
                "retrieval_query": retrieval_query,
                "sources": results,
            }
        )
        try:
            for piece in client.chat_stream(
                system,
                user_payload,
                feature="code_chat_answer_stream",
                project_id=pid or "",
            ):
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


@router.post("/code-chat/feedback")
def code_chat_feedback(
    body: CodeChatFeedbackBody,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    from app.llm_usage import record_llm_feedback

    record_llm_feedback(
        feature="code_chat_answer",
        provider="unknown",
        model="unknown",
        project_id=(body.project_id or "").strip(),
        rating=body.rating,
        reason=body.reason,
    )
    return {"ok": True}
