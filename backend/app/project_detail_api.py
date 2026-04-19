from __future__ import annotations

import asyncio
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.audit_helpers import actor_from_user, request_meta
from app.audit_repo import append_audit_event
from app.auth_ui import require_ui_session
from app.effective_settings import detect_git_provider
from app.impact_repo import get_impact_analysis_run, list_impact_analysis_runs
from app.issue_poster import list_issue_label_options, set_issue_labels
from app.issue_rules_repo import get_issue_reply_rules, save_issue_reply_rules
from app.job_queue import get_job_queue, get_job_store
from app.project_issue_repo import get_project_issue, list_project_issues, update_issue_labels
from app.query import _repo_url_for_browser
from app.vector_project_index_repo import get_project_index_meta, set_project_repo_overrides

router = APIRouter()


class IssueRulesBody(BaseModel):
    auto_post_default: bool = False
    blocked_keywords: list[str] = Field(default_factory=list)
    require_human_keywords: list[str] = Field(default_factory=list)
    reply_template: str = Field(default="", max_length=4000)
    reply_requirements: str = Field(default="", max_length=4000)


class ProjectRepoOverridesBody(BaseModel):
    repo_provider_override: str = Field(default="", max_length=64)
    repo_web_base_url: str = Field(default="", max_length=2000)


class IssueLabelsBody(BaseModel):
    labels: list[str] = Field(default_factory=list)


@router.get("/projects/{project_id:path}/summary")
async def get_project_summary(
    project_id: str,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    pid = str(project_id or "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="project_id is required")
    meta = await asyncio.to_thread(get_project_index_meta, pid)
    if not meta:
        raise HTTPException(status_code=404, detail="project not found")

    store = get_job_store()
    latest_jobs = await asyncio.to_thread(store.list_jobs, project_id=pid, limit=1, offset=0)
    latest_job = latest_jobs[0] if latest_jobs else None
    latest_repo_url = await asyncio.to_thread(store.latest_repo_url_for_project, pid)
    issue_total = await asyncio.to_thread(store.count_jobs, project_id=pid)
    impact_total, latest_impacts = await asyncio.to_thread(list_impact_analysis_runs, pid, limit=1, offset=0)
    latest_impact = latest_impacts[0] if latest_impacts else None
    repo_url_source = str(meta.get("repo_web_base_url") or latest_repo_url or (latest_job.repo_url if latest_job else "")).strip()
    repo_url = _repo_url_for_browser(repo_url_source, pid)
    repo_provider_override = str(meta.get("repo_provider_override") or "").strip() or None

    return {
        "project_id": pid,
        "project_name": meta.get("project_name") or latest_job.project_name if latest_job else None,
        "doc_count": int(meta.get("doc_count") or 0),
        "repo_provider": repo_provider_override
        or str(meta.get("repo_provider") or detect_git_provider(repo_url_source) or "")
        or None,
        "repo_provider_override": repo_provider_override,
        "repo_web_base_url": str(meta.get("repo_web_base_url") or latest_repo_url or "").strip() or None,
        "repo_url": repo_url,
        "last_indexed_commit": meta.get("last_indexed_commit") or None,
        "last_analyzed_commit": meta.get("last_analyzed_commit") or None,
        "last_impact_job_id": meta.get("last_impact_job_id") or None,
        "last_local_repo_path": meta.get("last_local_repo_path") or None,
        "latest_job": {
            "job_id": latest_job.job_id,
            "job_type": latest_job.job_type,
            "status": latest_job.status,
            "created_at": latest_job.created_at,
            "finished_at": latest_job.finished_at,
        }
        if latest_job
        else None,
        "issue_job_count": int(
            len([j for j in await asyncio.to_thread(store.list_jobs, project_id=pid, limit=200, offset=0) if j.job_type == "issue_reply"])
        ),
        "impact_run_count": impact_total,
        "latest_impact": {
            "job_id": latest_impact.get("job_id"),
            "commit_sha": latest_impact.get("commit_sha"),
            "risk_level": latest_impact.get("risk_level"),
            "created_at": latest_impact.get("created_at"),
        }
        if latest_impact
        else None,
        "job_count": issue_total,
    }


@router.put("/projects/{project_id:path}/repo-config")
async def update_project_repo_config(
    project_id: str,
    body: ProjectRepoOverridesBody,
    request: Request,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    saved = await asyncio.to_thread(
        set_project_repo_overrides,
        project_id,
        repo_provider_override=body.repo_provider_override,
        repo_web_base_url=body.repo_web_base_url,
    )
    if not saved:
        raise HTTPException(status_code=404, detail="project not found")
    meta = await asyncio.to_thread(get_project_index_meta, project_id)
    req = request_meta(request)
    append_audit_event(
        event_type="project.repo_config.update",
        actor=actor_from_user(_user),
        route=req["route"],
        method=req["method"],
        resource_type="project",
        resource_id=str(project_id or "").strip(),
        status="ok",
        payload={
            "repo_provider_override": str((meta or {}).get("repo_provider_override") or "").strip(),
            "repo_web_base_url": str((meta or {}).get("repo_web_base_url") or "").strip(),
        },
        ip=req["ip"],
        user_agent=req["user_agent"],
    )
    return {
        "project_id": str(project_id or "").strip(),
        "repo_provider_override": str((meta or {}).get("repo_provider_override") or "").strip(),
        "repo_web_base_url": str((meta or {}).get("repo_web_base_url") or "").strip(),
    }


@router.get("/projects/{project_id:path}/issue-rules")
async def get_project_issue_rules(
    project_id: str,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    return await asyncio.to_thread(get_issue_reply_rules, project_id)


@router.put("/projects/{project_id:path}/issue-rules")
async def update_project_issue_rules(
    project_id: str,
    body: IssueRulesBody,
    request: Request,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    saved = await asyncio.to_thread(
        save_issue_reply_rules,
        project_id=project_id,
        auto_post_default=body.auto_post_default,
        blocked_keywords=body.blocked_keywords,
        require_human_keywords=body.require_human_keywords,
        reply_template=body.reply_template,
        reply_requirements=body.reply_requirements,
    )
    meta = request_meta(request)
    append_audit_event(
        event_type="issue_rules.update",
        actor=actor_from_user(_user),
        route=meta["route"],
        method=meta["method"],
        resource_type="project",
        resource_id=str(project_id or "").strip(),
        status="ok",
        payload={
            "auto_post_default": saved["auto_post_default"],
            "blocked_keywords": saved["blocked_keywords"],
            "require_human_keywords": saved["require_human_keywords"],
            "reply_template": saved["reply_template"],
            "reply_requirements": saved["reply_requirements"],
        },
        ip=meta["ip"],
        user_agent=meta["user_agent"],
    )
    return saved


@router.get("/projects/{project_id:path}/issue-jobs")
async def list_project_issue_jobs(
    project_id: str,
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _user: Annotated[Optional[str], Depends(require_ui_session)] = None,
):
    store = get_job_store()
    jobs = await asyncio.to_thread(store.list_jobs, project_id=project_id, limit=200, offset=0)
    rows = [job for job in jobs if job.job_type == "issue_reply"]
    total = len(rows)
    page = rows[offset : offset + limit]
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "jobs": [
            {
                "job_id": job.job_id,
                "project_id": job.project_id,
                "project_name": job.project_name or None,
                "job_type": job.job_type,
                "payload": job.payload,
                "result": job.result,
                "status": job.status,
                "progress": job.progress,
                "step": job.step,
                "message": job.message,
                "created_at": job.created_at,
                "started_at": job.started_at,
                "finished_at": job.finished_at,
                "failure_reason": job.failure_reason or None,
                "log_excerpt": job.log_excerpt or None,
                "is_current": get_job_queue().get_current_job_id() == job.job_id,
            }
            for job in page
        ],
    }


@router.get("/projects/{project_id:path}/issues")
async def list_project_issues_api(
    project_id: str,
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _user: Annotated[Optional[str], Depends(require_ui_session)] = None,
):
    total, rows = await asyncio.to_thread(list_project_issues, project_id, limit=limit, offset=offset)
    return {"total": total, "limit": limit, "offset": offset, "issues": rows}


@router.get("/projects/{project_id:path}/issues/{provider}/{issue_number}")
async def get_project_issue_api(
    project_id: str,
    provider: str,
    issue_number: str,
    _user: Annotated[Optional[str], Depends(require_ui_session)] = None,
):
    issue = await asyncio.to_thread(get_project_issue, project_id, provider, issue_number)
    if not issue:
        raise HTTPException(status_code=404, detail="issue not found")
    latest_job_id = str(issue.get("latest_reply_job_id") or "").strip()
    latest_job = await asyncio.to_thread(get_job_store().get_job, latest_job_id) if latest_job_id else None
    return {
        **issue,
        "latest_reply_job": {
            "job_id": latest_job.job_id,
            "project_id": latest_job.project_id,
            "project_name": latest_job.project_name or None,
            "job_type": latest_job.job_type,
            "payload": latest_job.payload,
            "result": latest_job.result,
            "status": latest_job.status,
            "progress": latest_job.progress,
            "step": latest_job.step,
            "message": latest_job.message,
            "created_at": latest_job.created_at,
            "started_at": latest_job.started_at,
            "finished_at": latest_job.finished_at,
            "failure_reason": latest_job.failure_reason or None,
            "log_excerpt": latest_job.log_excerpt or None,
            "is_current": get_job_queue().get_current_job_id() == latest_job.job_id,
        }
        if latest_job
        else None,
    }


@router.get("/projects/{project_id:path}/issues/{provider}/{issue_number}/labels/options")
async def get_project_issue_label_options_api(
    project_id: str,
    provider: str,
    issue_number: str,
    _user: Annotated[Optional[str], Depends(require_ui_session)] = None,
):
    issue = await asyncio.to_thread(get_project_issue, project_id, provider, issue_number)
    if not issue:
        raise HTTPException(status_code=404, detail="issue not found")
    options = await asyncio.to_thread(
        list_issue_label_options,
        provider=provider,
        project_id=project_id,
        repo_url=str(issue.get("repo_url") or ""),
    )
    labels = sorted({*list(issue.get("labels") or []), *options})
    return {
        "project_id": str(project_id or "").strip(),
        "provider": str(provider or "").strip().lower(),
        "issue_number": str(issue_number or "").strip(),
        "current_labels": list(issue.get("labels") or []),
        "available_labels": labels,
        "supports_update": str(provider or "").strip().lower() in {"github", "gitlab"},
    }


@router.put("/projects/{project_id:path}/issues/{provider}/{issue_number}/labels")
async def update_project_issue_labels_api(
    project_id: str,
    provider: str,
    issue_number: str,
    body: IssueLabelsBody,
    request: Request,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    issue = await asyncio.to_thread(get_project_issue, project_id, provider, issue_number)
    if not issue:
        raise HTTPException(status_code=404, detail="issue not found")
    result = await asyncio.to_thread(
        set_issue_labels,
        provider=provider,
        project_id=project_id,
        repo_url=str(issue.get("repo_url") or ""),
        issue_number=issue_number,
        labels=body.labels,
    )
    if not result.updated:
        detail = result.error or "failed to update issue labels"
        if "unsupported provider" in detail:
            raise HTTPException(status_code=400, detail=detail)
        if "not configured" in detail:
            raise HTTPException(status_code=503, detail=detail)
        raise HTTPException(status_code=502, detail=detail)
    saved = await asyncio.to_thread(
        update_issue_labels,
        project_id=project_id,
        provider=provider,
        issue_number=issue_number,
        labels=result.labels,
        status=result.issue_state or str(issue.get("status") or ""),
    )
    updated_issue = await asyncio.to_thread(get_project_issue, project_id, provider, issue_number)
    meta = request_meta(request)
    append_audit_event(
        event_type="issue.labels.update",
        actor=actor_from_user(_user),
        route=meta["route"],
        method=meta["method"],
        resource_type="issue",
        resource_id=f"{str(project_id or '').strip()}:{str(provider or '').strip().lower()}:{str(issue_number or '').strip()}",
        status="ok" if saved else "partial",
        payload={
            "labels": result.labels,
            "provider": str(provider or "").strip().lower(),
            "issue_number": str(issue_number or "").strip(),
        },
        ip=meta["ip"],
        user_agent=meta["user_agent"],
    )
    return {
        "project_id": str(project_id or "").strip(),
        "provider": str(provider or "").strip().lower(),
        "issue_number": str(issue_number or "").strip(),
        "labels": result.labels,
        "issue": updated_issue,
        "saved_locally": bool(saved),
    }


@router.get("/projects/{project_id:path}/impact-runs")
async def list_project_impact_runs(
    project_id: str,
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _user: Annotated[Optional[str], Depends(require_ui_session)] = None,
):
    total, rows = await asyncio.to_thread(list_impact_analysis_runs, project_id, limit=limit, offset=offset)
    return {"total": total, "limit": limit, "offset": offset, "runs": rows}


@router.get("/projects/{project_id:path}/impact-runs/{job_id}")
async def get_project_impact_run(
    project_id: str,
    job_id: str,
    _user: Annotated[Optional[str], Depends(require_ui_session)] = None,
):
    row = await asyncio.to_thread(get_impact_analysis_run, job_id)
    if not row or str(row.get("project_id") or "") != str(project_id or "").strip():
        raise HTTPException(status_code=404, detail="impact run not found")
    return row
