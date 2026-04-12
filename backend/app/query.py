from __future__ import annotations

from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.config import settings

router = APIRouter()


class QueryBody(BaseModel):
    query: str
    project_id: Optional[str] = None
    top_k: int = 10


@router.post("/query")
def query(body: QueryBody):
    """语义检索：根据问题在已索引的项目功能说明中检索，供 Dify 或前端调用。"""
    from app.vector_store import get_vector_store
    store = get_vector_store()
    results = store.query(text=body.query, project_id=body.project_id, top_k=body.top_k)
    return {"results": results}


def _repo_url_for_browser(raw: str, project_id: str) -> str | None:
    """
    将任务里保存的 clone URL 转为浏览器可打开的 HTTPS 地址；失败时用 GITLAB_EXTERNAL_URL + path 兜底。
    """
    u = (raw or "").strip()
    if u.startswith(("http://", "https://")):
        return u.split("#", 1)[0].rstrip("/")
    if u.startswith("git@"):
        rest = u[4:]
        if ":" in rest:
            host, path = rest.split(":", 1)
            path = path.removesuffix(".git").lstrip("/")
            if host and path:
                return f"https://{host}/{path}"
    if u.startswith("ssh://"):
        try:
            pr = urlparse(u)
            if pr.hostname and pr.path:
                path = pr.path.removesuffix(".git")
                return f"https://{pr.hostname}{path}".rstrip("/")
        except Exception:
            pass
    base = (settings.gitlab_external_url or "").strip().rstrip("/")
    pid = (project_id or "").strip().strip("/")
    if base and pid and "/" in pid and "://" not in pid:
        return f"{base}/{pid}"
    return None


def _enrich_projects_from_jobs(projects: list[dict]) -> None:
    """合并任务表中的展示名、仓库地址（供概览跳转 GitLab）。"""
    from app.job_queue import get_job_store

    store = get_job_store()
    job_names = store.latest_project_name_by_project_id()
    job_urls = store.latest_repo_url_by_project_id()
    for p in projects:
        pid = str(p.get("project_id", ""))
        cached = str(p.get("project_name", "") or "").strip()
        fallback_name = (job_names.get(pid) or "").strip()
        name = cached or fallback_name
        p["project_name"] = name if name else None
        raw_repo = (job_urls.get(pid) or "").strip()
        p["repo_url"] = _repo_url_for_browser(raw_repo, pid)


@router.get("/projects")
def list_projects(
    q: Optional[str] = Query(
        None,
        description="按 project_id 或项目名称（展示名）子串过滤（不区分大小写）",
    ),
    limit: Optional[int] = Query(None, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """
    列出当前向量库中已索引的项目。

    - 不传 ``limit``：返回全部匹配项（兼容旧客户端）；``offset`` 在未传 ``limit`` 时忽略。
    - 传入 ``limit``：分页返回，响应含 ``total``（过滤后总数）、``limit``、``offset``。
    - 每项含 ``project_name``：索引时传入的展示名（或最近一次任务中的名称），可能为 ``null``。
    - 每项含 ``repo_url``：可在浏览器打开的仓库页地址；无则 ``null``（可配置 ``GITLAB_EXTERNAL_URL`` 兜底）。
    """
    from app.vector_store import get_vector_store

    store = get_vector_store()
    projects = store.list_projects()
    _enrich_projects_from_jobs(projects)
    needle = (q or "").strip().lower()
    if needle:
        projects = [
            p
            for p in projects
            if needle in str(p.get("project_id", "")).lower()
            or needle in str(p.get("project_name") or "").lower()
        ]
    total = len(projects)
    if limit is not None:
        lim = int(limit)
        off = int(offset)
        page = projects[off : off + lim]
        return {
            "total": total,
            "limit": lim,
            "offset": off,
            "projects": page,
        }
    return {"total": total, "projects": projects}

@router.get("/search")
def search(
    q: str = Query(..., description="检索问题"),
    project_id: Optional[str] = Query(None),
    top_k: int = Query(10, ge=1, le=50),
):
    """GET 形式的语义检索。"""
    from app.vector_store import get_vector_store
    store = get_vector_store()
    results = store.query(text=q, project_id=project_id, top_k=top_k)
    return {"results": results}


@router.get("/project/index-status")
def project_index_status(
    project_id: str = Query(..., description="与触发索引时传入的 project_id 一致（如 GitLab 项目 ID 或自定义别名）"),
):
    """
    查询该项目是否已完成向量索引（向量库中是否存在该 project_id 的文档）。

    说明：
    - **indexed=true**：已成功写入至少一条向量，可正常语义检索。
    - **indexed=false**：未索引，或索引时全部 embedding 失败未写入、或仅跑了 SKIP_VECTOR_STORE 等。
    - **doc_count**：该项目在库中的向量条数。
    """
    from app.vector_store import get_vector_store

    store = get_vector_store()
    status = store.get_project_index_status(project_id)
    return {
        **status,
        "processed": status["indexed"],
    }
