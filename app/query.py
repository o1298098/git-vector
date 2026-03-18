from __future__ import annotations

from typing import Optional
from fastapi import APIRouter, Query
from pydantic import BaseModel

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


@router.get("/projects")
def list_projects():
    """
    列出当前向量库中已索引的项目。

    返回示例：
    {
        "total": 2,
        "projects": [
            {"project_id": "my-repo", "doc_count": 120},
            {"project_id": "another-repo", "doc_count": 80}
        ]
    }

    - project_id：通常对应你在触发索引时传入的 project_id（例如 GitLab 的 project_id 或自定义别名）
    - doc_count：该项目在向量库中的向量条数，用于大致判断索引规模
    """
    from app.vector_store import get_vector_store

    store = get_vector_store()
    projects = store.list_projects()
    return {"total": len(projects), "projects": projects}

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
