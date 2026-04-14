from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query

from app.auth_ui import require_ui_session
from app.llm_usage import read_llm_usage_summary

router = APIRouter()


@router.get("/admin/llm-usage")
def llm_usage_summary(
    days: int = Query(30, ge=1, le=3650),
    tz_offset_minutes: int = Query(0, ge=-840, le=840),
    _user: Annotated[Optional[str], Depends(require_ui_session)] = None,
):
    return read_llm_usage_summary(days=days, tz_offset_minutes=tz_offset_minutes)
