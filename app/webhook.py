from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Optional
from fastapi import APIRouter, Request, Header, HTTPException, BackgroundTasks, Body
from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/trigger")
async def trigger_index(
    background_tasks: BackgroundTasks,
    repo_url: str = Body(..., embed=True),
    project_id: Optional[str] = Body(None),
):
    """手动触发一次索引（不依赖 GitLab Webhook）。"""
    pid = project_id or repo_url.split("/")[-1].replace(".git", "")
    if settings.gitlab_access_token and "http" in repo_url:
        from urllib.parse import urlparse
        u = urlparse(repo_url)
        repo_url = f"{u.scheme}://oauth2:{settings.gitlab_access_token}@{u.netloc}{u.path}"
    from app.indexer import run_index_pipeline
    background_tasks.add_task(run_index_pipeline, repo_url=repo_url, project_id=pid)
    return {"status": "accepted", "project_id": pid}


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


@router.post("/gitlab")
async def gitlab_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    x_gitlab_token: Optional[str] = Header(None),
):
    body = await request.body()
    if not _verify_gitlab_token(body, x_gitlab_token):
        raise HTTPException(status_code=403, detail="Invalid webhook secret")

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    if data.get("object_kind") != "push":
        return {"status": "ignored", "reason": "not a push event"}

    ref = data.get("ref", "")
    if not ref.endswith("/main") and not ref.endswith("/master"):
        return {"status": "ignored", "reason": f"ref not main/master: {ref}"}

    project = data.get("project", {})
    repo_url = project.get("http_url") or project.get("ssh_url_to_repo")
    project_id = project.get("id") or project.get("path_with_namespace", "unknown")

    if not repo_url:
        raise HTTPException(status_code=400, detail="Missing project URL")

    # 克隆/拉取需要 token 时，注入到 URL
    if settings.gitlab_access_token and "http" in repo_url:
        from urllib.parse import urlparse
        u = urlparse(repo_url)
        repo_url = f"{u.scheme}://oauth2:{settings.gitlab_access_token}@{u.netloc}{u.path}"

    from app.indexer import run_index_pipeline
    background_tasks.add_task(
        run_index_pipeline,
        repo_url=repo_url,
        project_id=str(project_id),
    )
    return {"status": "accepted", "project_id": project_id}
