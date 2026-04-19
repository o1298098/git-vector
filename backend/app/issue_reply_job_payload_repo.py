from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings

_lock = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> Path:
    return settings.data_path / "issue_reply_job_payloads.sqlite3"


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _init(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=8000;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS issue_reply_job_payloads (
            job_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL DEFAULT '',
            provider TEXT NOT NULL DEFAULT '',
            issue_number TEXT NOT NULL DEFAULT '',
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_reply_job_payloads_project ON issue_reply_job_payloads(project_id, updated_at DESC)"
    )
    conn.commit()


def save_issue_reply_job_payload(*, job_id: str, payload: dict[str, Any]) -> bool:
    jid = str(job_id or "").strip()
    if not jid:
        return False
    payload_obj = payload if isinstance(payload, dict) else {}
    project_id = str(payload_obj.get("project_id") or "").strip()
    provider = str(payload_obj.get("provider") or "").strip().lower()
    issue_number = str(payload_obj.get("issue_number") or "").strip()
    try:
        payload_json = json.dumps(payload_obj, ensure_ascii=False)
    except Exception:
        payload_json = "{}"
    now = _utc_now_iso()
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            conn.execute(
                """
                INSERT INTO issue_reply_job_payloads (
                    job_id, project_id, provider, issue_number, payload_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    project_id=excluded.project_id,
                    provider=excluded.provider,
                    issue_number=excluded.issue_number,
                    payload_json=excluded.payload_json,
                    updated_at=excluded.updated_at
                """,
                (jid, project_id, provider, issue_number, payload_json, now, now),
            )
            conn.commit()
            return True
        finally:
            conn.close()


def get_issue_reply_job_payload(job_id: str) -> dict[str, Any]:
    jid = str(job_id or "").strip()
    if not jid:
        return {}
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            row = conn.execute(
                "SELECT payload_json FROM issue_reply_job_payloads WHERE job_id=?",
                (jid,),
            ).fetchone()
        finally:
            conn.close()
    if not row:
        return {}
    try:
        payload = json.loads(str(row["payload_json"] or "{}"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}
