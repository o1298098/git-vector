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


def read_llm_usage_summary(*, days: int = 30) -> dict[str, Any]:
    d = max(1, min(int(days), 3650))
    now_utc = datetime.now(timezone.utc)
    start_day = (now_utc - timedelta(days=d - 1)).date()
    since = datetime.combine(start_day, time.min, tzinfo=timezone.utc).isoformat()
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
            by_day_rows = conn.execute(
                """
                SELECT substr(ts, 1, 10) AS day,
                       COUNT(*) AS calls,
                       SUM(prompt_tokens) AS prompt_tokens,
                       SUM(completion_tokens) AS completion_tokens,
                       SUM(total_tokens) AS total_tokens
                FROM llm_usage
                WHERE ts >= ?
                GROUP BY substr(ts, 1, 10)
                ORDER BY day ASC
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
    for r in by_day_rows:
        day_map[str(r["day"])] = {
            "calls": _n(r["calls"]),
            "prompt_tokens": _n(r["prompt_tokens"]),
            "completion_tokens": _n(r["completion_tokens"]),
            "total_tokens": _n(r["total_tokens"]),
        }

    by_day: list[dict[str, Any]] = []
    cur: date = start_day
    end_day = now_utc.date()
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

    return {
        "days": d,
        "totals": totals,
        "by_provider": [dict(r) for r in by_provider],
        "by_feature": [dict(r) for r in by_feature],
        "by_day": by_day,
    }
