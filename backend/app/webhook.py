from __future__ import annotations

import hashlib
import hmac
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from app.config import settings
from app.issue_reply_job_payload_repo import save_issue_reply_job_payload
from app.job_queue import get_job_queue, sanitize_text
from app.project_issue_repo import get_project_issue, update_issue_reply_state, upsert_project_issue
from app.vector_store import resolve_project_display_name_for_enqueue

router = APIRouter()
logger = logging.getLogger(__name__)


class TriggerBody(BaseModel):
    repo_url: str = Field(..., description="Git 仓库 URL")
    project_id: Optional[str] = Field(None, description="项目标识（不填则从 URL 推断）")
    project_name: Optional[str] = Field(
        None,
        description="项目中文名或展示名（可选，会写入 Wiki 首页与任务记录）",
    )


class LocalCommitBody(BaseModel):
    project_id: str = Field(..., description="项目标识")
    repo_path: str = Field(..., description="本地仓库路径")
    repo_url: str = Field("", description="仓库 URL，可选")
    project_name: Optional[str] = Field(None, description="展示名称")
    commit_sha: str = Field(..., description="当前提交 SHA")
    parent_commit_sha: str = Field("", description="父提交 SHA")
    branch: str = Field("", description="当前分支")
    author: str = Field("", description="提交作者")
    message: str = Field("", description="提交信息")
    trigger_source: str = Field("git_hook", description="触发来源")


class IssueEventBody(BaseModel):
    provider: str = Field("generic", description="事件来源平台")
    project_id: str = Field(..., description="项目标识")
    project_name: Optional[str] = Field(None, description="展示名称")
    repo_url: str = Field("", description="仓库 URL")
    issue_number: str = Field("", description="issue 编号")
    issue_url: str = Field("", description="issue 链接")
    title: str = Field("", description="issue 标题")
    body: str = Field("", description="issue 正文")
    issue_body: str = Field("", description="issue 首帖正文")
    comment_body: str = Field("", description="本次评论正文")
    event_kind: str = Field("issue", description="事件类型：issue/comment")
    issue_created_at: str = Field("", description="issue 创建时间")
    event_created_at: str = Field("", description="事件发生时间")
    comment_id: str = Field("", description="评论 ID")
    comment_url: str = Field("", description="评论链接")
    author: str = Field("", description="发起人")
    issue_author: str = Field("", description="issue 作者")
    comment_author: str = Field("", description="评论作者")
    labels: list[str] = Field(default_factory=list, description="labels")
    action: str = Field("opened", description="事件动作")
    comments: list[str] = Field(default_factory=list, description="最近评论")
    auto_post: bool = Field(True, description="是否允许自动回复")
    source: str = Field("webhook", description="消息来源")


def _enqueue_if_main_branch(
    ref: str,
    repo_url: Optional[str],
    project_id: str,
    project_name: str,
) -> dict[str, Any]:
    if not ref.endswith("/main") and not ref.endswith("/master"):
        return {"status": "ignored", "reason": f"ref not main/master: {ref}"}
    if not repo_url:
        raise HTTPException(status_code=400, detail="Missing repository URL")

    pname = resolve_project_display_name_for_enqueue(str(project_id), project_name)
    job = get_job_queue().enqueue(
        project_id=str(project_id),
        repo_url=str(repo_url),
        project_name=pname,
        job_type="index",
    )
    return {
        "status": "queued",
        "project_id": project_id,
        "project_name": pname or None,
        "job_id": job.job_id,
    }


def _queue_issue_reply(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = IssueEventBody.model_validate(payload)
    body = normalized.model_dump()
    if not str(normalized.project_id or "").strip() or not str(normalized.issue_number or "").strip():
        logger.warning("invalid issue payload rejected: %s", json.dumps(body, ensure_ascii=False)[:2000])
        raise HTTPException(status_code=400, detail="invalid issue payload: missing project_id or issue_number")
    pname = resolve_project_display_name_for_enqueue(str(normalized.project_id), (normalized.project_name or "").strip())
    previous_issue = get_project_issue(str(normalized.project_id), str(normalized.provider), str(normalized.issue_number))
    issue = upsert_project_issue(payload=body)

    action = str(normalized.action or "").strip().lower()
    event_kind = str(normalized.event_kind or "issue").strip().lower()
    normalized_status = str((body.get("status") or "")).strip().lower()
    previous_issue_status = str((previous_issue or {}).get("status") or "").strip().lower()
    if not normalized_status and previous_issue_status == "closed" and action in {"update", "updated", "edit", "edited"}:
        normalized_status = "closed"
    comment_author = str(normalized.comment_author or normalized.author or "").strip().lower()
    has_comment_body = bool(str(normalized.comment_body or "").strip())
    has_issue_prompt = bool(str(normalized.issue_body or normalized.body or normalized.title or "").strip())
    has_issue_body = bool(str(normalized.issue_body or normalized.body or "").strip())
    is_issue_state_open = normalized_status in {"", "open", "opened", "reopened", "active", "todo"}
    is_issue_state_closed = normalized_status in {"closed", "close", "resolved", "done", "deleted"}
    is_non_reply_update = action in {"edit", "edited", "update", "updated", "close", "closed", "delete", "deleted", "comment_edited", "comment_deleted"}
    latest_reply_preview = str((previous_issue or {}).get("latest_reply_preview") or "").strip()
    latest_reply_matches_comment = bool(latest_reply_preview) and str(normalized.comment_body or "").strip() == latest_reply_preview
    is_bot_comment = event_kind == "comment" and (
        comment_author in {"bot", "git-vector-bot", "gitvector-bot", "assistant", "ai", "robot"}
        or latest_reply_matches_comment
    )
    should_trigger_reply = (
        (event_kind == "comment" and has_comment_body and not is_bot_comment and not is_issue_state_closed)
        or (event_kind == "issue" and has_issue_prompt and is_issue_state_open and not is_issue_state_closed and not is_non_reply_update)
    )
    if not should_trigger_reply:
        return {
            "status": "ignored",
            "reason": "issue event synced without auto reply",
            "project_id": normalized.project_id,
            "project_name": pname or None,
            "provider": normalized.provider,
            "issue_number": normalized.issue_number,
            "event_kind": event_kind,
            "action": action,
            "issue_status": issue.get("status") or "",
            "comment_author": normalized.comment_author,
            "ignored_as_bot_comment": is_bot_comment,
            "ignored_as_closed_issue": is_issue_state_closed,
            "previous_issue_status": previous_issue_status,
        }

    job = get_job_queue().enqueue(
        project_id=str(normalized.project_id),
        repo_url=normalized.repo_url or "issue-event",
        project_name=pname,
        job_type="issue_reply",
    )
    saved = save_issue_reply_job_payload(job_id=job.job_id, payload=body)
    if not saved:
        logger.error("issue reply payload save failed job_id=%s", job.job_id)
        raise HTTPException(status_code=500, detail="failed to persist issue reply payload")
    update_issue_reply_state(
        project_id=str(normalized.project_id),
        provider=str(issue.get("provider") or normalized.provider),
        issue_number=str(issue.get("issue_number") or normalized.issue_number),
        latest_reply_job_id=job.job_id,
        latest_reply_status="queued",
    )
    return {
        "status": "queued",
        "job_id": job.job_id,
        "project_id": normalized.project_id,
        "project_name": pname or None,
        "job_type": job.job_type,
        "provider": normalized.provider,
        "issue_number": normalized.issue_number,
    }


def _gitlab_extract_state_value(value: Any) -> str:
    if isinstance(value, str):
        return value.strip().lower()
    if isinstance(value, dict):
        for key in ("name", "state", "event", "value", "title"):
            text = str(value.get(key) or "").strip().lower()
            if text:
                return text
    return ""


def _gitlab_issue_payload(data: dict[str, Any]) -> dict[str, Any] | None:
    object_kind = str(data.get("object_kind") or "").strip().lower()
    event_type = str(data.get("event_type") or data.get("event_name") or "").strip().lower()
    attrs = data.get("object_attributes") or {}
    work_item = data.get("work_item") or {}
    project = data.get("project") or {}
    user = data.get("user") or {}
    note = data.get("object_attributes") or {}
    changes = data.get("changes") or {}
    is_note_event = object_kind == "note" or event_type == "note"
    noteable_type = str(note.get("noteable_type") or "").strip().lower()
    if is_note_event and noteable_type not in {"issue", "workitem", "work_item", "task"}:
        return None

    labels = data.get("labels") or attrs.get("labels") or work_item.get("labels") or []
    is_issue_like = object_kind == "issue" or event_type == "issue"
    is_work_item_like = object_kind == "work_item" or event_type == "work_item"
    work_item_type = str(attrs.get("type") or work_item.get("type") or "").strip().lower()
    if not is_issue_like and not is_work_item_like and not is_note_event:
        return None
    if is_work_item_like and work_item_type not in {"", "issue", "task"}:
        return None

    source = work_item if isinstance(work_item, dict) and work_item else attrs
    if is_note_event:
        source = (data.get("issue") or note.get("issue") or work_item or source) if isinstance(note, dict) else source
    project_id = str(
        project.get("path_with_namespace")
        or source.get("project_path_with_namespace")
        or source.get("reference")
        or project.get("id")
        or source.get("project_id")
        or ""
    ).strip()
    if project_id.startswith("#"):
        project_id = ""
    issue_number = str(source.get("iid") or source.get("issue_iid") or source.get("id") or "").strip()
    if not project_id or not issue_number:
        return None
    comment_body = str(note.get("note") or note.get("description") or "").strip() if isinstance(note, dict) else ""
    issue_body = str(source.get("description") or "")
    state_change = changes.get("state") or changes.get("state_id") or changes.get("work_item_state") or {}
    previous_state = _gitlab_extract_state_value((state_change or {}).get("previous")) if isinstance(state_change, dict) else ""
    current_state = _gitlab_extract_state_value((state_change or {}).get("current")) if isinstance(state_change, dict) else ""
    raw_state_values = [
        _gitlab_extract_state_value(source.get("state")),
        _gitlab_extract_state_value(attrs.get("state")),
        _gitlab_extract_state_value(source.get("work_item_state")),
        _gitlab_extract_state_value(attrs.get("work_item_state")),
        _gitlab_extract_state_value(source.get("state_id")),
        _gitlab_extract_state_value(attrs.get("state_id")),
        current_state,
        previous_state,
    ]
    normalized_issue_status = next((value for value in raw_state_values if value), "")
    state_event = _gitlab_extract_state_value((state_change or {}).get("event")) if isinstance(state_change, dict) else ""
    base_action = str(
        source.get("action")
        or attrs.get("action")
        or state_event
        or current_state
        or source.get("state")
        or "opened"
    ).strip().lower() or "opened"
    created_at = str(source.get("created_at") or attrs.get("created_at") or "").strip()
    event_created_at = str(note.get("created_at") or note.get("updated_at") or created_at).strip() if is_note_event else created_at
    issue_author = str((source.get("author") or {}).get("name") or (source.get("author") or {}).get("username") or "").strip()
    comment_author = str(user.get("name") or user.get("username") or issue_author).strip()
    if normalized_issue_status in {"closed", "close", "deleted", "resolved"}:
        normalized_issue_status = "closed"
    elif normalized_issue_status in {"opened", "open", "reopened", "active", "todo"}:
        normalized_issue_status = "open"
    elif not normalized_issue_status and base_action in {"close", "closed"}:
        normalized_issue_status = "closed"
    elif not normalized_issue_status and base_action in {"reopen", "reopened", "open", "opened"}:
        normalized_issue_status = "open"
    logger.info(
        "gitlab issue payload parsed issue=%s object_kind=%s event_type=%s action=%s status=%s raw_state_values=%s changes=%s",
        issue_number,
        object_kind,
        event_type,
        base_action,
        normalized_issue_status,
        json.dumps(raw_state_values, ensure_ascii=False),
        json.dumps(changes, ensure_ascii=False)[:2000],
    )
    return {
        "provider": "gitlab",
        "project_id": project_id,
        "project_name": str(project.get("name") or source.get("project_name") or "").strip(),
        "repo_url": str(project.get("web_url") or project.get("git_http_url") or project.get("git_ssh_url") or "").strip(),
        "issue_number": issue_number,
        "issue_url": str(source.get("url") or source.get("web_url") or attrs.get("url") or "").strip(),
        "title": str(source.get("title") or "").strip(),
        "body": comment_body or issue_body,
        "issue_body": issue_body,
        "comment_body": comment_body,
        "event_kind": "comment" if is_note_event else "issue",
        "issue_created_at": created_at,
        "event_created_at": event_created_at,
        "comment_id": str(note.get("id") or "").strip() if isinstance(note, dict) else "",
        "comment_url": str(note.get("url") or source.get("url") or source.get("web_url") or "").strip() if is_note_event else "",
        "author": comment_author if is_note_event else (issue_author or comment_author),
        "issue_author": issue_author or comment_author,
        "comment_author": comment_author,
        "status": normalized_issue_status,
        "labels": [
            str(label.get("title") or label.get("name") or label).strip()
            for label in labels
            if str(label.get("title") or label.get("name") or label).strip()
        ],
        "action": (f"comment_{base_action}" if is_note_event else (base_action or "opened")),
        "comments": [comment_body] if comment_body else [],
        "auto_post": True,
        "source": "webhook",
    }


def _github_issue_payload(data: dict[str, Any]) -> dict[str, Any] | None:
    issue = data.get("issue") or {}
    repo = data.get("repository") or {}
    sender = data.get("sender") or {}
    comment = data.get("comment") or {}
    project_id = str(repo.get("full_name") or repo.get("name") or repo.get("id") or "").strip()
    issue_number = str(issue.get("number") or "").strip()
    if not project_id or not issue_number:
        return None
    comment_body = str(comment.get("body") or "").strip()
    issue_body = str(issue.get("body") or "")
    action = str(data.get("action") or issue.get("state") or "opened").strip().lower() or "opened"
    is_comment_event = bool(comment)
    issue_author = str((issue.get("user") or {}).get("login") or sender.get("login") or "").strip()
    comment_author = str((comment.get("user") or {}).get("login") or sender.get("login") or issue_author).strip()
    issue_created_at = str(issue.get("created_at") or "").strip()
    event_created_at = str(comment.get("created_at") or comment.get("updated_at") or issue_created_at).strip() if is_comment_event else issue_created_at
    return {
        "provider": "github",
        "project_id": project_id,
        "project_name": str(repo.get("name") or "").strip(),
        "repo_url": str(repo.get("html_url") or repo.get("clone_url") or repo.get("git_url") or repo.get("ssh_url") or "").strip(),
        "issue_number": issue_number,
        "issue_url": str(issue.get("html_url") or "").strip(),
        "title": str(issue.get("title") or "").strip(),
        "body": comment_body or issue_body,
        "issue_body": issue_body,
        "comment_body": comment_body,
        "event_kind": "comment" if is_comment_event else "issue",
        "issue_created_at": issue_created_at,
        "event_created_at": event_created_at,
        "comment_id": str(comment.get("id") or "").strip(),
        "comment_url": str(comment.get("html_url") or "").strip(),
        "author": comment_author if is_comment_event else issue_author,
        "issue_author": issue_author,
        "comment_author": comment_author,
        "status": str(issue.get("state") or "").strip().lower(),
        "labels": [
            str(label.get("name") or "").strip()
            for label in (issue.get("labels") or [])
            if isinstance(label, dict) and str(label.get("name") or "").strip()
        ],
        "action": (f"comment_{action}" if is_comment_event else action),
        "comments": [comment_body] if comment_body else [],
        "auto_post": True,
        "source": "webhook",
    }


def _gitea_issue_payload(data: dict[str, Any]) -> dict[str, Any] | None:
    issue = data.get("issue") or {}
    repo = data.get("repository") or {}
    sender = data.get("sender") or {}
    comment = data.get("comment") or {}
    project_id = str(repo.get("full_name") or repo.get("name") or repo.get("id") or "").strip()
    issue_number = str(issue.get("number") or issue.get("index") or "").strip()
    if not project_id or not issue_number:
        return None
    comment_body = str(comment.get("body") or "").strip()
    issue_body = str(issue.get("body") or "")
    action = str(data.get("action") or issue.get("state") or "opened").strip().lower() or "opened"
    is_comment_event = bool(comment)
    issue_author = str((issue.get("user") or {}).get("login") or sender.get("login") or "").strip()
    comment_author = str((comment.get("user") or {}).get("login") or sender.get("login") or issue_author).strip()
    issue_created_at = str(issue.get("created_at") or "").strip()
    event_created_at = str(comment.get("created_at") or comment.get("updated_at") or issue_created_at).strip() if is_comment_event else issue_created_at
    return {
        "provider": "gitea",
        "project_id": project_id,
        "project_name": str(repo.get("name") or "").strip(),
        "repo_url": str(repo.get("html_url") or repo.get("clone_url") or repo.get("ssh_url") or "").strip(),
        "issue_number": issue_number,
        "issue_url": str(issue.get("html_url") or "").strip(),
        "title": str(issue.get("title") or "").strip(),
        "body": comment_body or issue_body,
        "issue_body": issue_body,
        "comment_body": comment_body,
        "event_kind": "comment" if is_comment_event else "issue",
        "issue_created_at": issue_created_at,
        "event_created_at": event_created_at,
        "comment_id": str(comment.get("id") or "").strip(),
        "comment_url": str(comment.get("html_url") or "").strip(),
        "author": comment_author if is_comment_event else issue_author,
        "issue_author": issue_author,
        "comment_author": comment_author,
        "status": str(issue.get("state") or "").strip().lower(),
        "labels": [
            str(label.get("name") or "").strip()
            for label in (issue.get("labels") or [])
            if isinstance(label, dict) and str(label.get("name") or "").strip()
        ],
        "action": (f"comment_{action}" if is_comment_event else action),
        "comments": [comment_body] if comment_body else [],
        "auto_post": True,
        "source": "webhook",
    }


def _verify_gitlab_token(payload: bytes, token: Optional[str]) -> bool:
    if not settings.gitlab_webhook_secret:
        return True
    if not token:
        return False
    expected = "sha256=" + hmac.new(
        settings.gitlab_webhook_secret.encode(),
        payload,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, token)


def _verify_github_signature(payload: bytes, signature: Optional[str]) -> bool:
    secret = (settings.github_webhook_secret or "").strip()
    if not secret:
        return True
    if not signature or not signature.startswith("sha256="):
        return False
    digest = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    expected = "sha256=" + digest
    return hmac.compare_digest(expected, signature)


def _verify_gitea_signature(payload: bytes, signature: Optional[str]) -> bool:
    secret = (settings.gitea_webhook_secret or "").strip()
    if not secret:
        return True
    if not signature:
        return False
    digest = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    sig = signature.strip().lower()
    return hmac.compare_digest(digest, sig)


@router.post("/trigger")
async def trigger_index(body: TriggerBody):
    """手动触发一次索引（任意 Git 托管）。支持 JSON：`repo_url`、`project_id`、`project_name`。"""
    pid = body.project_id or body.repo_url.split("/")[-1].replace(".git", "")
    pname = (body.project_name or "").strip()
    job = get_job_queue().enqueue(project_id=str(pid), repo_url=body.repo_url, project_name=pname, job_type="index")
    return {
        "status": "queued",
        "project_id": pid,
        "project_name": pname or None,
        "job_id": job.job_id,
    }


@router.post("/local-commit")
async def local_commit_webhook(body: LocalCommitBody):
    pname = resolve_project_display_name_for_enqueue(str(body.project_id), (body.project_name or "").strip())
    payload = {
        "repo_path": sanitize_text(body.repo_path),
        "branch": body.branch,
        "commit_sha": body.commit_sha,
        "parent_commit_sha": body.parent_commit_sha,
        "author": body.author,
        "message": body.message,
        "trigger_source": body.trigger_source,
    }
    job = get_job_queue().enqueue(
        project_id=str(body.project_id),
        repo_url=body.repo_url or body.repo_path,
        project_name=pname,
        job_type="impact_analysis",
        payload=payload,
    )
    return {
        "status": "queued",
        "job_id": job.job_id,
        "project_id": body.project_id,
        "project_name": pname or None,
        "job_type": job.job_type,
    }


@router.post("/issue-event")
async def issue_event_webhook(body: IssueEventBody):
    return _queue_issue_reply(body.model_dump())


@router.post("/gitlab")
async def gitlab_webhook(
    request: Request,
    x_gitlab_token: Optional[str] = Header(None),
):
    body = await request.body()
    if not _verify_gitlab_token(body, x_gitlab_token):
        raise HTTPException(status_code=403, detail="Invalid webhook secret")

    try:
        data = json.loads(body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    issue_payload = _gitlab_issue_payload(data)
    if issue_payload is not None:
        return _queue_issue_reply(issue_payload)

    if str(data.get("object_kind") or "").strip().lower() in {"issue", "work_item"}:
        logger.warning(
            "gitlab webhook issue/work_item payload unsupported object_kind=%s event_type=%s object_attributes=%s work_item=%s",
            data.get("object_kind"),
            data.get("event_type") or data.get("event_name"),
            json.dumps(data.get("object_attributes") or {}, ensure_ascii=False)[:2000],
            json.dumps(data.get("work_item") or {}, ensure_ascii=False)[:2000],
        )
        return {
            "status": "ignored",
            "reason": "unsupported or incomplete gitlab issue/work item payload",
            "object_kind": data.get("object_kind"),
            "event_type": data.get("event_type") or data.get("event_name"),
        }

    if data.get("object_kind") != "push":
        return {"status": "ignored", "reason": "not a supported gitlab event"}

    ref = data.get("ref", "")
    project = data.get("project", {})
    repo_url = project.get("http_url") or project.get("ssh_url_to_repo")
    path_ns = project.get("path_with_namespace")
    if isinstance(path_ns, str) and path_ns.strip():
        project_id = path_ns.strip()
    else:
        project_id = str(project.get("id") or "unknown")
    project_name = str(project.get("name") or "").strip()

    return _enqueue_if_main_branch(ref, repo_url, str(project_id), project_name)


@router.post("/github")
async def github_webhook(
    request: Request,
    x_hub_signature_256: Optional[str] = Header(None, alias="X-Hub-Signature-256"),
    x_github_event: Optional[str] = Header(None, alias="X-GitHub-Event"),
):
    body = await request.body()
    if not _verify_github_signature(body, x_hub_signature_256):
        raise HTTPException(status_code=403, detail="Invalid webhook signature")

    event = (x_github_event or "").strip().lower()
    if event == "ping":
        return {"status": "ignored", "reason": "ping"}

    try:
        data = json.loads(body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    if event in {"issues", "issue_comment"}:
        issue_payload = _github_issue_payload(data)
        if issue_payload is None:
            return {"status": "ignored", "reason": "invalid github issue payload"}
        return _queue_issue_reply(issue_payload)

    if event != "push":
        return {"status": "ignored", "reason": f"not a supported github event: {x_github_event!r}"}

    ref = data.get("ref", "")
    repo = data.get("repository") or {}
    repo_url = repo.get("clone_url") or repo.get("git_url") or repo.get("ssh_url")
    full_name = repo.get("full_name")
    if isinstance(full_name, str) and full_name.strip():
        project_id = full_name.strip()
    else:
        project_id = str(repo.get("name") or repo.get("id") or "unknown")
    project_name = str(repo.get("name") or "").strip()

    return _enqueue_if_main_branch(ref, repo_url, str(project_id), project_name)


@router.post("/gitea")
async def gitea_webhook(
    request: Request,
    x_gitea_signature: Optional[str] = Header(None, alias="X-Gitea-Signature"),
    x_gitea_event: Optional[str] = Header(None, alias="X-Gitea-Event"),
):
    body = await request.body()
    if not _verify_gitea_signature(body, x_gitea_signature):
        raise HTTPException(status_code=403, detail="Invalid webhook signature")

    event = (x_gitea_event or "").strip().lower()
    if event == "ping":
        return {"status": "ignored", "reason": "ping"}

    try:
        data = json.loads(body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    if event in {"issues", "issue_comment"}:
        issue_payload = _gitea_issue_payload(data)
        if issue_payload is None:
            return {"status": "ignored", "reason": "invalid gitea issue payload"}
        return _queue_issue_reply(issue_payload)

    if event != "push":
        return {"status": "ignored", "reason": f"not a supported gitea event: {x_gitea_event!r}"}

    ref = data.get("ref", "")
    repo = data.get("repository") or {}
    repo_url = repo.get("clone_url") or repo.get("ssh_url")
    project_id = repo.get("full_name") or repo.get("name") or "unknown"
    project_name = str(repo.get("name") or "").strip()

    return _enqueue_if_main_branch(ref, repo_url, str(project_id), project_name)
