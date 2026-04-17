from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query

from app.audit_repo import get_audit_repo
from app.auth_ui import require_ui_session

router = APIRouter()


@router.get("/admin/audit-events")
def list_audit_events(
    _user: Annotated[Optional[str], Depends(require_ui_session)],
    event_type: Optional[str] = Query(None),
    actor: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    resource_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    created_from: Optional[str] = Query(None, description="ISO8601 起始时间"),
    created_to: Optional[str] = Query(None, description="ISO8601 结束时间"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    repo = get_audit_repo()
    total, events = repo.list_events(
        limit=limit,
        offset=offset,
        event_type=event_type,
        actor=actor,
        resource_type=resource_type,
        resource_id=resource_id,
        status=status,
        created_from=created_from,
        created_to=created_to,
    )
    # 避免 payload 过大影响接口响应体
    for e in events:
        payload = e.get("payload")
        if isinstance(payload, dict):
            raw = str(payload)
            if len(raw) > 4000:
                e["payload"] = {"truncated": True, "raw_len": len(raw)}
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "events": events,
    }
