from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.job_queue import get_job_queue, get_job_store, JobStatus
from app.wiki_generator import wiki_manifest

router = APIRouter()


class EnqueueBody(BaseModel):
    repo_url: str = Field(..., description="Git 仓库 URL（http/https/ssh 均可）")
    project_id: Optional[str] = Field(None, description="项目标识（不填则从 repo_url 推断）")
    project_name: Optional[str] = Field(
        None,
        description="项目中文名或展示名（可选，写入 Wiki 与任务记录）",
    )


@router.post("/index-jobs/enqueue")
async def enqueue_index_job(body: EnqueueBody):
    pid = body.project_id or body.repo_url.split("/")[-1].replace(".git", "")
    pname = (body.project_name or "").strip()
    q = get_job_queue()
    job = await asyncio.to_thread(q.enqueue, str(pid), body.repo_url, pname)
    return {
        "status": "queued",
        "job_id": job.job_id,
        "project_id": job.project_id,
        "project_name": job.project_name or None,
    }


@router.post("/index-jobs/{job_id}/cancel")
async def cancel_index_job(job_id: str):
    """取消排队中或正在执行的索引任务（正在执行时会终止子进程）。"""
    q = get_job_queue()
    result = await asyncio.to_thread(q.request_cancel, job_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="job not found")
    if result == "already_done":
        raise HTTPException(status_code=409, detail="job already finished")
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
        "status": job.status,
        "progress": job.progress,
        "step": job.step,
        "message": job.message,
        "created_at": job.created_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "is_current": (get_job_queue().get_current_job_id() == job.job_id),
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
                "status": j.status,
                "progress": j.progress,
                "step": j.step,
                "message": j.message,
                "created_at": j.created_at,
                "started_at": j.started_at,
                "finished_at": j.finished_at,
                "is_current": (j.job_id == current),
            }
            for j in jobs
        ],
    }

