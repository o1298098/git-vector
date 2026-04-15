from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from app.config import settings
from app.vector_store import resolve_project_display_name_for_enqueue

router = APIRouter()


class TriggerBody(BaseModel):
    repo_url: str = Field(..., description="Git 仓库 URL")
    project_id: Optional[str] = Field(None, description="项目标识（不填则从 URL 推断）")
    project_name: Optional[str] = Field(
        None,
        description="项目中文名或展示名（可选，会写入 Wiki 首页与任务记录）",
    )


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
    from app.job_queue import get_job_queue

    pname = resolve_project_display_name_for_enqueue(str(project_id), project_name)
    job = get_job_queue().enqueue(
        project_id=str(project_id),
        repo_url=str(repo_url),
        project_name=pname,
    )
    return {
        "status": "queued",
        "project_id": project_id,
        "project_name": pname or None,
        "job_id": job.job_id,
    }


@router.post("/trigger")
async def trigger_index(body: TriggerBody):
    """手动触发一次索引（任意 Git 托管）。支持 JSON：`repo_url`、`project_id`、`project_name`。"""
    pid = body.project_id or body.repo_url.split("/")[-1].replace(".git", "")
    pname = (body.project_name or "").strip()
    from app.job_queue import get_job_queue

    job = get_job_queue().enqueue(project_id=str(pid), repo_url=body.repo_url, project_name=pname)
    return {
        "status": "queued",
        "project_id": pid,
        "project_name": pname or None,
        "job_id": job.job_id,
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

    if data.get("object_kind") != "push":
        return {"status": "ignored", "reason": "not a push event"}

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
    if event != "push":
        return {"status": "ignored", "reason": f"not a push event: {x_github_event!r}"}

    try:
        data = json.loads(body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

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
    if event != "push":
        return {"status": "ignored", "reason": f"not a push event: {x_gitea_event!r}"}

    try:
        data = json.loads(body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    ref = data.get("ref", "")
    repo = data.get("repository") or {}
    repo_url = repo.get("clone_url") or repo.get("ssh_url")
    project_id = repo.get("full_name") or repo.get("name") or "unknown"
    project_name = str(repo.get("name") or "").strip()

    return _enqueue_if_main_branch(ref, repo_url, str(project_id), project_name)
