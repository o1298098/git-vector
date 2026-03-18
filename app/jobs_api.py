from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field

from app.job_queue import get_job_queue, get_job_store, JobStatus

router = APIRouter()


class EnqueueBody(BaseModel):
    repo_url: str = Field(..., description="Git 仓库 URL（http/https/ssh 均可）")
    project_id: Optional[str] = Field(None, description="项目标识（不填则从 repo_url 推断）")


@router.post("/index-jobs/enqueue")
def enqueue_index_job(body: EnqueueBody):
    pid = body.project_id or body.repo_url.split("/")[-1].replace(".git", "")
    q = get_job_queue()
    job = q.enqueue(project_id=str(pid), repo_url=body.repo_url)
    return {"status": "queued", "job_id": job.job_id, "project_id": job.project_id}


@router.get("/index-jobs/{job_id}")
def get_index_job(job_id: str):
    store = get_job_store()
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {
        "job_id": job.job_id,
        "project_id": job.project_id,
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


@router.get("/index-jobs")
def list_index_jobs(
    status: Optional[JobStatus] = Query(None),
    project_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    store = get_job_store()
    jobs = store.list_jobs(status=status, project_id=project_id, limit=limit, offset=offset)
    current = get_job_queue().get_current_job_id()
    return {
        "total": len(jobs),
        "jobs": [
            {
                "job_id": j.job_id,
                "project_id": j.project_id,
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

