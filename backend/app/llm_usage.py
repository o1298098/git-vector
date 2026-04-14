from __future__ import annotations

import sqlite3
import threading
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

from app.config import settings

_lock = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> Path:
    return settings.data_path / "llm_usage.sqlite3"


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(_db_path()), check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def _init(c: sqlite3.Connection) -> None:
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS llm_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            feature TEXT NOT NULL,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            success INTEGER NOT NULL DEFAULT 1
        )
        """
    )
    c.execute("CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_llm_usage_provider ON llm_usage(provider)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_llm_usage_feature ON llm_usage(feature)")
    c.commit()


def estimate_tokens(text: str) -> int:
    # 轻量近似：英文约 4 字符/Token；中文会偏差但可做兜底统计。
    s = (text or "").strip()
    if not s:
        return 0
    return max(1, int(len(s) / 4))


def record_llm_usage(
    *,
    provider: str,
    model: str,
    feature: str,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    total_tokens: int | None = None,
    prompt_text: str = "",
    completion_text: str = "",
    success: bool = True,
) -> None:
    p = max(0, int(prompt_tokens if prompt_tokens is not None else estimate_tokens(prompt_text)))
    c = max(0, int(completion_tokens if completion_tokens is not None else estimate_tokens(completion_text)))
    t = max(0, int(total_tokens if total_tokens is not None else (p + c)))
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            conn.execute(
                """
                INSERT INTO llm_usage
                (ts, provider, model, feature, prompt_tokens, completion_tokens, total_tokens, success)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _utc_now_iso(),
                    (provider or "unknown").strip() or "unknown",
                    (model or "unknown").strip() or "unknown",
                    (feature or "general").strip() or "general",
                    p,
                    c,
                    t,
                    1 if success else 0,
                ),
            )
            conn.commit()
        finally:
            conn.close()


def read_llm_usage_summary(*, days: int = 30, tz_offset_minutes: int = 0) -> dict[str, Any]:
    d = max(1, min(int(days), 3650))
    offset = max(-840, min(int(tz_offset_minutes), 840))
    local_tz = timezone(timedelta(minutes=offset))
    now_utc = datetime.now(timezone.utc)
    now_local = now_utc.astimezone(local_tz)
    start_local_day = (now_local - timedelta(days=d - 1)).date()
    since_utc_dt = datetime.combine(start_local_day, time.min, tzinfo=local_tz).astimezone(timezone.utc)
    since = since_utc_dt.isoformat()
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            total_row = conn.execute(
                """
                SELECT
                  COUNT(*) AS calls,
                  SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS success_calls,
                  SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failed_calls,
                  SUM(prompt_tokens) AS prompt_tokens,
                  SUM(completion_tokens) AS completion_tokens,
                  SUM(total_tokens) AS total_tokens
                FROM llm_usage
                WHERE ts >= ?
                """,
                (since,),
            ).fetchone()
            by_provider = conn.execute(
                """
                SELECT provider,
                       COUNT(*) AS calls,
                       SUM(prompt_tokens) AS prompt_tokens,
                       SUM(completion_tokens) AS completion_tokens,
                       SUM(total_tokens) AS total_tokens
                FROM llm_usage
                WHERE ts >= ?
                GROUP BY provider
                ORDER BY total_tokens DESC, provider ASC
                """,
                (since,),
            ).fetchall()
            by_feature = conn.execute(
                """
                SELECT feature,
                       COUNT(*) AS calls,
                       SUM(prompt_tokens) AS prompt_tokens,
                       SUM(completion_tokens) AS completion_tokens,
                       SUM(total_tokens) AS total_tokens
                FROM llm_usage
                WHERE ts >= ?
                GROUP BY feature
                ORDER BY total_tokens DESC, feature ASC
                LIMIT 20
                """,
                (since,),
            ).fetchall()
            usage_rows = conn.execute(
                """
                SELECT ts,
                       prompt_tokens,
                       completion_tokens,
                       total_tokens
                FROM llm_usage
                WHERE ts >= ?
                ORDER BY ts ASC
                """,
                (since,),
            ).fetchall()
        finally:
            conn.close()

    def _n(v: Any) -> int:
        if v is None:
            return 0
        return int(v)

    totals = {
        "calls": _n(total_row["calls"]) if total_row else 0,
        "success_calls": _n(total_row["success_calls"]) if total_row else 0,
        "failed_calls": _n(total_row["failed_calls"]) if total_row else 0,
        "prompt_tokens": _n(total_row["prompt_tokens"]) if total_row else 0,
        "completion_tokens": _n(total_row["completion_tokens"]) if total_row else 0,
        "total_tokens": _n(total_row["total_tokens"]) if total_row else 0,
    }
    day_map: dict[str, dict[str, int]] = {}
    hour_map: dict[str, dict[str, int]] = {}
    for r in usage_rows:
        ts_raw = r["ts"]
        if ts_raw is None:
            continue
        try:
            dt_utc = datetime.fromisoformat(str(ts_raw))
        except ValueError:
            continue
        if dt_utc.tzinfo is None:
            dt_utc = dt_utc.replace(tzinfo=timezone.utc)
        dt_local = dt_utc.astimezone(local_tz)
        day_key = dt_local.date().isoformat()
        hour_key = dt_local.replace(minute=0, second=0, microsecond=0).isoformat()
        day_rec = day_map.setdefault(
            day_key,
            {
                "calls": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            },
        )
        day_rec["calls"] += 1
        day_rec["prompt_tokens"] += _n(r["prompt_tokens"])
        day_rec["completion_tokens"] += _n(r["completion_tokens"])
        day_rec["total_tokens"] += _n(r["total_tokens"])

        hour_rec = hour_map.setdefault(
            hour_key,
            {
                "calls": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            },
        )
        hour_rec["calls"] += 1
        hour_rec["prompt_tokens"] += _n(r["prompt_tokens"])
        hour_rec["completion_tokens"] += _n(r["completion_tokens"])
        hour_rec["total_tokens"] += _n(r["total_tokens"])

    by_day: list[dict[str, Any]] = []
    cur: date = start_local_day
    end_day = now_local.date()
    while cur <= end_day:
        ds = cur.isoformat()
        rec = day_map.get(ds) or {
            "calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }
        by_day.append({"day": ds, **rec})
        cur = cur + timedelta(days=1)

    by_hour: list[dict[str, Any]] = []
    start_hour = datetime.combine(start_local_day, time.min, tzinfo=local_tz)
    end_hour = now_local.replace(minute=0, second=0, microsecond=0)
    cur_hour = start_hour
    while cur_hour <= end_hour:
        hk = cur_hour.isoformat()
        rec = hour_map.get(hk) or {
            "calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }
        by_hour.append({"hour": hk, **rec})
        cur_hour = cur_hour + timedelta(hours=1)

    return {
        "days": d,
        "totals": totals,
        "by_provider": [dict(r) for r in by_provider],
        "by_feature": [dict(r) for r in by_feature],
        "by_day": by_day,
        "by_hour": by_hour if d == 1 else [],
    }
