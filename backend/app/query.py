from __future__ import annotations

import asyncio
from typing import Annotated, Any, Optional
from urllib.parse import quote, urlparse

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth_ui import require_ui_session
from app.config import settings

router = APIRouter()


class QueryBody(BaseModel):
    query: str
    project_id: Optional[str] = None
    top_k: int = 10


class VectorItem(BaseModel):
    id: str
    content: str
    metadata: dict[str, Any]


class VectorListResponse(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[VectorItem]


class UpdateVectorBody(BaseModel):
    content: str
    metadata: dict[str, Any]


@router.post("/query")
def query(body: QueryBody):
    """语义检索：根据问题在已索引的项目功能说明中检索，供 Dify 或前端调用。"""
    from app.vector_store import get_vector_store
    store = get_vector_store()
    results = store.query(text=body.query, project_id=body.project_id, top_k=body.top_k)
    return {"results": _enrich_search_results(results)}


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


def _anchor_for_lines(host: str, start_line: int | None, end_line: int | None) -> str:
    if not start_line or start_line <= 0:
        return ""
    if end_line and end_line > 0 and end_line != start_line:
        if "gitlab" in host:
            return f"#L{start_line}-{end_line}"
        return f"#L{start_line}-L{end_line}"
    return f"#L{start_line}"


def _source_url_for_hit(
    raw_repo_url: str,
    project_id: str,
    path: str,
    start_line: int | None,
    end_line: int | None,
) -> str | None:
    base = _repo_url_for_browser(raw_repo_url, project_id)
    if not base or not path:
        return None
    p = quote(path.strip().lstrip("/"), safe="/._-+")
    host = (urlparse(base).hostname or "").lower()
    anchor = _anchor_for_lines(host, start_line, end_line)
    if "gitlab" in host:
        return f"{base}/-/blob/main/{p}{anchor}"
    return f"{base}/blob/main/{p}{anchor}"


def _int_or_none(v: Any) -> int | None:
    try:
        n = int(v)
        return n if n > 0 else None
    except Exception:
        return None


def _citation_for_hit(project_id: str, path: str, start_line: int | None, end_line: int | None) -> str:
    if not project_id and not path:
        return ""
    rng = ""
    if start_line:
        rng = f":{start_line}"
        if end_line and end_line != start_line:
            rng += f"-{end_line}"
    return f"{project_id}:{path}{rng}".strip(":")


def _enrich_search_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from app.job_queue import get_job_store

    repo_urls = get_job_store().latest_repo_url_by_project_id()
    enriched: list[dict[str, Any]] = []
    for item in results:
        row = dict(item or {})
        meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        project_id = str(meta.get("project_id") or "").strip()
        path = str(meta.get("path") or meta.get("file") or "").strip()
        start_line = _int_or_none(meta.get("start_line"))
        end_line = _int_or_none(meta.get("end_line"))
        source_url = _source_url_for_hit(repo_urls.get(project_id, ""), project_id, path, start_line, end_line)
        citation = _citation_for_hit(project_id, path, start_line, end_line)
        if source_url:
            row["source_url"] = source_url
        if citation:
            row["citation"] = citation
        enriched.append(row)
    return enriched


def _enrich_projects_from_jobs(projects: list[dict]) -> None:
    """合并任务表中的展示名、仓库地址、创建时间（供概览跳转 GitLab）。"""
    from app.job_queue import get_job_store

    store = get_job_store()
    job_names = store.latest_project_name_by_project_id()
    job_urls = store.latest_repo_url_by_project_id()
    job_created = store.earliest_job_created_at_by_project_id()
    for p in projects:
        pid = str(p.get("project_id", ""))
        cached = str(p.get("project_name", "") or "").strip()
        fallback_name = (job_names.get(pid) or "").strip()
        name = cached or fallback_name
        p["project_name"] = name if name else None
        raw_repo = (job_urls.get(pid) or "").strip()
        p["repo_url"] = _repo_url_for_browser(raw_repo, pid)
        first_at = (job_created.get(pid) or "").strip()
        p["created_at"] = first_at if first_at else None


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
    - 每项含 ``created_at``：该项目在任务表中最早一条索引任务的创建时间（ISO 8601）；无任务记录则为 ``null``。
    - 返回顺序：按 ``created_at`` **降序**（新的在前）；无创建时间的项目排在最后，其次按 ``project_id`` 升序。
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
    # 创建时间新的在前；无任务时间时靠后；同一时间按 project_id 稳定排序
    projects.sort(key=lambda p: str(p.get("project_id", "")))
    projects.sort(key=lambda p: p.get("created_at") or "", reverse=True)
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


@router.delete("/projects/{project_id:path}")
def delete_project(
    project_id: str,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    """
    从向量库移除指定项目的全部检索数据，并删除本机已生成的 Wiki 站点目录。

    - 与 ``GET /api/projects`` 使用相同的 ``project_id``（可含 ``/`` 等字符）。
    - 索引任务表中的历史记录**不会**删除。
    - 若未启用管理登录（未设置 ``ADMIN_PASSWORD``），本接口与入队接口一样不校验令牌；
      启用后需携带与设置页相同的 Bearer。
    """
    from app.vector_store import get_vector_store
    from app.wiki_generator import remove_project_wiki_artifacts

    try:
        store = get_vector_store()
        r = store.purge_project(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    wiki_removed = remove_project_wiki_artifacts(r["project_id"])
    if not r["had_vectors_or_cache"] and not wiki_removed:
        raise HTTPException(status_code=404, detail="未找到该项目或未建立索引")
    return {
        "ok": True,
        "project_id": r["project_id"],
        "removed_docs": r["removed_docs"],
        "wiki_removed": wiki_removed,
    }


@router.post("/projects/{project_id:path}/reindex")
async def reindex_project(
    project_id: str,
    _user: Annotated[Optional[str], Depends(require_ui_session)],
):
    """
    基于该项目最近一次任务中的仓库 URL 重新入队索引。

    - 若从未有过该项目的历史任务，返回 404。
    - 仅复用最近一次任务中的 ``repo_url`` 与 ``project_name``。
    """
    from app.job_queue import get_job_queue, get_job_store

    store = get_job_store()
    jobs = await asyncio.to_thread(store.list_jobs, project_id=project_id, limit=1, offset=0)
    if not jobs:
        raise HTTPException(status_code=404, detail="未找到该项目的历史任务，无法重建索引")
    latest = jobs[0]
    if not latest.repo_url:
        raise HTTPException(status_code=400, detail="该项目缺少可用仓库地址，无法重建索引")

    q = get_job_queue()
    job = await asyncio.to_thread(q.enqueue, latest.project_id, latest.repo_url, latest.project_name or "")
    return {
        "status": "queued",
        "job_id": job.job_id,
        "project_id": job.project_id,
        "project_name": job.project_name or None,
    }


@router.get("/projects/{project_id:path}/vectors", response_model=VectorListResponse)
def list_project_vectors(
    project_id: str,
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    q: Optional[str] = Query(None, description="按路径/符号名/内容关键词过滤（不区分大小写）"),
    _user: Annotated[Optional[str], Depends(require_ui_session)] = None,
):
    from app.vector_store import get_vector_store

    store = get_vector_store()
    try:
        data = store.list_project_vectors(project_id=project_id, limit=limit, offset=offset, q=q)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return data


@router.patch("/projects/{project_id:path}/vectors/{vector_id:path}")
def update_project_vector(
    project_id: str,
    vector_id: str,
    body: UpdateVectorBody,
    _user: Annotated[Optional[str], Depends(require_ui_session)] = None,
):
    from app.vector_store import get_vector_store

    store = get_vector_store()
    try:
        data = store.update_project_vector(
            project_id=project_id,
            vector_id=vector_id,
            content=body.content,
            metadata=body.metadata,
        )
    except ValueError as e:
        msg = str(e)
        if "不存在" in msg:
            raise HTTPException(status_code=404, detail=msg) from e
        raise HTTPException(status_code=400, detail=msg) from e
    except Exception as e:  # noqa: S110
        raise HTTPException(status_code=500, detail=f"更新向量失败: {e}") from e
    return {"ok": True, **data}


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
    return {"results": _enrich_search_results(results)}


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
