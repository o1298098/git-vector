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
