from __future__ import annotations

import asyncio
import shutil
import subprocess
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.audit_helpers import actor_from_user, request_meta
from app.audit_repo import append_audit_event
from app.effective_settings import detect_git_provider
from app.job_queue import JobStatus, build_repo_url_for_clone, get_job_queue, get_job_store, sanitize_text
from app.issue_reply_job_payload_repo import get_issue_reply_job_payload, save_issue_reply_job_payload
from app.llm_client import precheck_llm_connectivity
from app.vector_store import precheck_embedding_connectivity
from app.config import settings
from app.wiki_generator import wiki_manifest

router = APIRouter()


class EnqueueBody(BaseModel):
    repo_url: str = Field(..., description="Git 仓库 URL（http/https/ssh 均可）")
    project_id: Optional[str] = Field(None, description="项目标识（不填则从 repo_url 推断）")
    project_name: Optional[str] = Field(
        None,
        description="项目中文名或展示名（可选，写入 Wiki 与任务记录）",
    )


class PrecheckBody(BaseModel):
    repo_url: str = Field(..., description="待索引仓库 URL")
    project_id: Optional[str] = Field(None, description="项目标识（可选）")


def _derive_project_id(repo_url: str, project_id: Optional[str] = None) -> str:
    pid = (project_id or "").strip()
    if pid:
        return pid
    clean = (repo_url or "").strip().rstrip("/")
    if not clean:
        return "unknown"
    tail = clean.split("/")[-1].replace(".git", "").strip()
    return tail or "unknown"


@router.post("/index-jobs/enqueue")
async def enqueue_index_job(body: EnqueueBody, request: Request):
    pid = _derive_project_id(body.repo_url, body.project_id)
    pname = (body.project_name or "").strip()
    q = get_job_queue()
    job = await asyncio.to_thread(q.enqueue, str(pid), body.repo_url, pname, job_type="index")
    meta = request_meta(request)
    append_audit_event(
        event_type="job.enqueue",
        actor=actor_from_user(None),
        route=meta["route"],
        method=meta["method"],
        resource_type="index_job",
        resource_id=job.job_id,
        status="ok",
        payload={
            "project_id": job.project_id,
            "project_name": job.project_name or "",
            "repo_url": sanitize_text(body.repo_url),
            "repo_provider": detect_git_provider(body.repo_url),
        },
        ip=meta["ip"],
        user_agent=meta["user_agent"],
    )
    return {
        "status": "queued",
        "job_id": job.job_id,
        "project_id": job.project_id,
        "project_name": job.project_name or None,
        "repo_provider": detect_git_provider(body.repo_url),
    }


@router.post("/index-jobs/{job_id}/retry")
async def retry_index_job(job_id: str, request: Request):
    """基于历史任务参数重试（保留 project_id / repo_url / project_name）。"""
    store = get_job_store()
    old = await asyncio.to_thread(store.get_job, job_id)
    if not old:
        raise HTTPException(status_code=404, detail="job not found")
    if old.status in ("queued", "running"):
        raise HTTPException(status_code=409, detail="job is not finished yet")
    q = get_job_queue()
    retry_payload = old.payload
    if old.job_type == "issue_reply":
        retry_payload = await asyncio.to_thread(get_issue_reply_job_payload, old.job_id)
        if not retry_payload:
            raise HTTPException(status_code=409, detail="issue reply payload missing for retry")
    job = await asyncio.to_thread(
        q.enqueue,
        old.project_id,
        old.repo_url,
        old.project_name or "",
        job_type=old.job_type,
        payload=retry_payload,
    )
    if old.job_type == "issue_reply":
        saved = await asyncio.to_thread(save_issue_reply_job_payload, job_id=job.job_id, payload=retry_payload)
        if not saved:
            raise HTTPException(status_code=500, detail="failed to persist issue reply payload for retry")
    meta = request_meta(request)
    append_audit_event(
        event_type="job.retry",
        actor=actor_from_user(None),
        route=meta["route"],
        method=meta["method"],
        resource_type="index_job",
        resource_id=job.job_id,
        status="ok",
        payload={"retry_of": old.job_id, "project_id": old.project_id, "job_type": old.job_type},
        ip=meta["ip"],
        user_agent=meta["user_agent"],
    )
    return {
        "status": "queued",
        "retry_of": old.job_id,
        "job_id": job.job_id,
        "project_id": job.project_id,
        "project_name": job.project_name or None,
    }


@router.post("/index-jobs/{job_id}/cancel")
async def cancel_index_job(job_id: str, request: Request):
    """取消排队中或正在执行的索引任务（正在执行时会终止子进程）。"""
    q = get_job_queue()
    result = await asyncio.to_thread(q.request_cancel, job_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="job not found")
    if result == "already_done":
        raise HTTPException(status_code=409, detail="job already finished")
    meta = request_meta(request)
    append_audit_event(
        event_type="job.cancel",
        actor=actor_from_user(None),
        route=meta["route"],
        method=meta["method"],
        resource_type="index_job",
        resource_id=job_id,
        status="ok",
        payload={"result": result},
        ip=meta["ip"],
        user_agent=meta["user_agent"],
    )
    return {"ok": True, "result": result}


@router.get("/index-jobs/{job_id}")
async def get_index_job(job_id: str):
    store = get_job_store()
    job = await asyncio.to_thread(store.get_job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {
        "job_id": job.job_id,
        "project_id": job.project_id,
        "project_name": job.project_name or None,
        "repo_url": job.repo_url,
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
        "is_current": (get_job_queue().get_current_job_id() == job.job_id),
    }


@router.get("/index-jobs/{job_id}/logs")
async def get_index_job_logs(
    job_id: str,
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    store = get_job_store()
    job = await asyncio.to_thread(store.get_job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    total = await asyncio.to_thread(store.count_job_logs, job_id)
    rows = await asyncio.to_thread(store.list_job_logs, job_id, limit=limit, offset=offset)
    return {
        "job_id": job_id,
        "total": total,
        "limit": limit,
        "offset": offset,
        "logs": [
            {
                "id": row.id,
                "sequence": row.sequence,
                "created_at": row.created_at,
                "level": row.level,
                "step": row.step or None,
                "message": row.message,
                "source": row.source,
            }
            for row in rows
        ],
    }


@router.get("/wiki/{project_id}")
async def get_wiki_meta(project_id: str):
    """返回最近一次生成的 Wiki 元数据（manifest.json）。"""
    m = await asyncio.to_thread(wiki_manifest, project_id)
    if not m:
        raise HTTPException(status_code=404, detail="wiki not found for project")
    return m


@router.get("/index-jobs")
async def list_index_jobs(
    status: Optional[JobStatus] = Query(None),
    project_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    store = get_job_store()
    filters = {"status": status, "project_id": project_id}
    total = await asyncio.to_thread(store.count_jobs, **filters)
    jobs = await asyncio.to_thread(
        store.list_jobs,
        **{**filters, "limit": limit, "offset": offset},
    )
    current = get_job_queue().get_current_job_id()
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "jobs": [
            {
                "job_id": j.job_id,
                "project_id": j.project_id,
                "project_name": j.project_name or None,
                "repo_url": j.repo_url,
                "job_type": j.job_type,
                "payload": j.payload,
                "result": j.result,
                "status": j.status,
                "progress": j.progress,
                "step": j.step,
                "message": j.message,
                "created_at": j.created_at,
                "started_at": j.started_at,
                "finished_at": j.finished_at,
                "failure_reason": j.failure_reason or None,
                "log_excerpt": j.log_excerpt or None,
                "is_current": (j.job_id == current),
            }
            for j in jobs
        ],
    }


def _run_git_ls_remote(repo_url: str) -> tuple[bool, str]:
    auth_url = build_repo_url_for_clone(repo_url)
    cmd = ["git", "ls-remote", "--heads", auth_url, "HEAD"]
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if r.returncode == 0:
            return True, "仓库可访问"
        detail = sanitize_text((r.stderr or r.stdout or "").strip())[:300]
        return False, detail or f"git ls-remote failed (code={r.returncode})"
    except Exception as e:  # noqa: S110
        return False, sanitize_text(str(e))


def _check_embedding() -> tuple[bool, str]:
    ok, msg = precheck_embedding_connectivity()
    return ok, sanitize_text(msg)


def _check_llm() -> tuple[bool, str]:
    ok, msg = precheck_llm_connectivity()
    return ok, sanitize_text(msg)


@router.post("/index-jobs/precheck")
async def precheck_index_job(body: PrecheckBody):
    """索引前健康检查：仓库连通、embedding/LLM 可用性、磁盘空间。"""
    repo_url = (body.repo_url or "").strip()
    if not repo_url:
        raise HTTPException(status_code=400, detail="repo_url 不能为空")

    repo_provider = detect_git_provider(repo_url)
    repo_ok, repo_detail = await asyncio.to_thread(_run_git_ls_remote, repo_url)
    emb_ok, emb_detail = await asyncio.to_thread(_check_embedding)
    llm_ok, llm_detail = await asyncio.to_thread(_check_llm)

    usage = shutil.disk_usage(settings.data_path)
    free_gb = usage.free / (1024**3)
    disk_ok = free_gb >= 1.0
    disk_detail = f"可用空间 {free_gb:.2f} GiB"

    checks = [
        {"key": "repo", "label": "仓库连通/权限", "ok": repo_ok, "detail": repo_detail},
        {"key": "provider", "label": "仓库类型识别", "ok": repo_provider != "generic", "detail": repo_provider},
        {"key": "embedding", "label": "Embedding 可用性", "ok": emb_ok, "detail": emb_detail},
        {"key": "llm", "label": "LLM 可用性", "ok": llm_ok, "detail": llm_detail},
        {"key": "disk", "label": "磁盘空间", "ok": disk_ok, "detail": disk_detail},
    ]
    return {
        "ok": all(bool(c["ok"]) for c in checks if c["key"] != "provider"),
        "repo_url": repo_url,
        "project_id": _derive_project_id(repo_url, body.project_id),
        "repo_provider": repo_provider,
        "checks": checks,
    }

