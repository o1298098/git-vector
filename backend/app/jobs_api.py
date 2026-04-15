from __future__ import annotations

import asyncio
import shutil
import subprocess
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.effective_settings import (
    effective_azure_openai_api_key,
    effective_azure_openai_endpoint,
    effective_azure_openai_version,
    effective_dify_api_key,
    effective_dify_base_url,
    effective_embed_model,
    effective_ollama_api_key,
    effective_ollama_base_url,
    effective_openai_api_key,
    effective_openai_base_url,
)
from app.job_queue import JobStatus, build_repo_url_for_clone, get_job_queue, get_job_store, sanitize_text
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


@router.post("/index-jobs/{job_id}/retry")
async def retry_index_job(job_id: str):
    """基于历史任务参数重试（保留 project_id / repo_url / project_name）。"""
    store = get_job_store()
    old = await asyncio.to_thread(store.get_job, job_id)
    if not old:
        raise HTTPException(status_code=404, detail="job not found")
    if old.status in ("queued", "running"):
        raise HTTPException(status_code=409, detail="job is not finished yet")
    q = get_job_queue()
    job = await asyncio.to_thread(q.enqueue, old.project_id, old.repo_url, old.project_name or "")
    return {
        "status": "queued",
        "retry_of": old.job_id,
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
        "failure_reason": job.failure_reason or None,
        "log_excerpt": job.log_excerpt or None,
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
    base_url = (effective_ollama_base_url() or "http://localhost:11434").strip()
    ollama_api_key = (effective_ollama_api_key() or "").strip()
    headers = {"Authorization": f"Bearer {ollama_api_key}"} if ollama_api_key else None
    model = effective_embed_model().strip()
    if not model:
        return False, "未配置 embed_model"
    try:
        with httpx.Client(base_url=base_url, timeout=20.0) as client:
            resp = client.post("/api/embeddings", headers=headers, json={"model": model, "prompt": "health check"})
            if resp.status_code >= 400:
                return False, f"Ollama HTTP {resp.status_code}"
            data = resp.json() if resp.content else {}
            emb = data.get("embedding") if isinstance(data, dict) else None
            embs = data.get("embeddings") if isinstance(data, dict) else None
            if emb or embs:
                return True, f"embedding 可用（model={model}）"
            return False, "embedding 返回为空"
    except Exception as e:  # noqa: S110
        return False, sanitize_text(str(e))


def _check_llm() -> tuple[bool, str]:
    dify_key = (effective_dify_api_key() or "").strip()
    dify_base = (effective_dify_base_url() or "").strip().rstrip("/")
    if dify_key and dify_base:
        try:
            with httpx.Client(timeout=20.0) as client:
                r = client.get(dify_base)
                if r.status_code < 500:
                    return True, "Dify 可达"
                return False, f"Dify HTTP {r.status_code}"
        except Exception as e:  # noqa: S110
            return False, sanitize_text(str(e))

    az_key = (effective_azure_openai_api_key() or "").strip()
    az_ep = (effective_azure_openai_endpoint() or "").strip().rstrip("/")
    if az_key and az_ep:
        version = (effective_azure_openai_version() or "2024-05-01-preview").strip()
        url = f"{az_ep}/openai/deployments?api-version={version}"
        try:
            with httpx.Client(timeout=20.0) as client:
                r = client.get(url, headers={"api-key": az_key})
                if r.status_code < 400:
                    return True, "Azure OpenAI 可达"
                return False, f"Azure OpenAI HTTP {r.status_code}"
        except Exception as e:  # noqa: S110
            return False, sanitize_text(str(e))

    oa_key = (effective_openai_api_key() or "").strip()
    oa_base = (effective_openai_base_url() or "https://api.openai.com/v1").strip().rstrip("/")
    if oa_key:
        try:
            with httpx.Client(timeout=20.0) as client:
                r = client.get(
                    f"{oa_base}/models",
                    headers={"Authorization": f"Bearer {oa_key}"},
                )
                if r.status_code < 400:
                    return True, "OpenAI 兼容接口可达"
                return False, f"OpenAI 兼容接口 HTTP {r.status_code}"
        except Exception as e:  # noqa: S110
            return False, sanitize_text(str(e))

    return True, "未配置 LLM（可选）"


@router.post("/index-jobs/precheck")
async def precheck_index_job(body: PrecheckBody):
    """索引前健康检查：仓库连通、embedding/LLM 可用性、磁盘空间。"""
    repo_url = (body.repo_url or "").strip()
    if not repo_url:
        raise HTTPException(status_code=400, detail="repo_url 不能为空")

    repo_ok, repo_detail = await asyncio.to_thread(_run_git_ls_remote, repo_url)
    emb_ok, emb_detail = await asyncio.to_thread(_check_embedding)
    llm_ok, llm_detail = await asyncio.to_thread(_check_llm)

    usage = shutil.disk_usage(settings.data_path)
    free_gb = usage.free / (1024**3)
    disk_ok = free_gb >= 1.0
    disk_detail = f"可用空间 {free_gb:.2f} GiB"

    checks = [
        {"key": "repo", "label": "仓库连通/权限", "ok": repo_ok, "detail": repo_detail},
        {"key": "embedding", "label": "Embedding 可用性", "ok": emb_ok, "detail": emb_detail},
        {"key": "llm", "label": "LLM 可用性", "ok": llm_ok, "detail": llm_detail},
        {"key": "disk", "label": "磁盘空间", "ok": disk_ok, "detail": disk_detail},
    ]
    return {
        "ok": all(bool(c["ok"]) for c in checks),
        "repo_url": repo_url,
        "project_id": (body.project_id or "").strip() or None,
        "checks": checks,
    }

