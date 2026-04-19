from __future__ import annotations

import json
import logging
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)
_lock = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> Path:
    return settings.data_path / "impact_analysis.sqlite3"


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _init(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=8000;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS impact_analysis_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL UNIQUE,
            project_id TEXT NOT NULL,
            repo_path TEXT NOT NULL DEFAULT '',
            repo_url TEXT NOT NULL DEFAULT '',
            branch TEXT NOT NULL DEFAULT '',
            commit_sha TEXT NOT NULL,
            base_commit_sha TEXT NOT NULL DEFAULT '',
            trigger_source TEXT NOT NULL DEFAULT '',
            risk_level TEXT NOT NULL DEFAULT 'unknown',
            status TEXT NOT NULL DEFAULT 'completed',
            summary_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_impact_runs_project_created ON impact_analysis_runs(project_id, created_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_impact_runs_commit ON impact_analysis_runs(commit_sha)"
    )
    conn.commit()


def save_impact_analysis_run(
    *,
    job_id: str,
    project_id: str,
    repo_path: str = "",
    repo_url: str = "",
    branch: str = "",
    commit_sha: str,
    base_commit_sha: str = "",
    trigger_source: str = "",
    risk_level: str = "unknown",
    status: str = "completed",
    summary: dict[str, Any] | None = None,
) -> None:
    now = _utc_now_iso()
    try:
        summary_json = json.dumps(summary or {}, ensure_ascii=False)
    except Exception:
        summary_json = "{}"
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            conn.execute(
                """
                INSERT INTO impact_analysis_runs (
                    job_id, project_id, repo_path, repo_url, branch, commit_sha, base_commit_sha,
                    trigger_source, risk_level, status, summary_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    project_id=excluded.project_id,
                    repo_path=excluded.repo_path,
                    repo_url=excluded.repo_url,
                    branch=excluded.branch,
                    commit_sha=excluded.commit_sha,
                    base_commit_sha=excluded.base_commit_sha,
                    trigger_source=excluded.trigger_source,
                    risk_level=excluded.risk_level,
                    status=excluded.status,
                    summary_json=excluded.summary_json,
                    updated_at=excluded.updated_at
                """,
                (
                    str(job_id or "").strip(),
                    str(project_id or "").strip(),
                    str(repo_path or "").strip(),
                    str(repo_url or "").strip(),
                    str(branch or "").strip(),
                    str(commit_sha or "").strip(),
                    str(base_commit_sha or "").strip(),
                    str(trigger_source or "").strip(),
                    str(risk_level or "unknown").strip() or "unknown",
                    str(status or "completed").strip() or "completed",
                    summary_json,
                    now,
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()


def _row_to_run(row: sqlite3.Row) -> dict[str, Any]:
    try:
        summary = json.loads(str(row["summary_json"] or "{}"))
        if not isinstance(summary, dict):
            summary = {"raw": summary}
    except Exception:
        summary = {}
    return {
        "id": int(row["id"]),
        "job_id": str(row["job_id"] or ""),
        "project_id": str(row["project_id"] or ""),
        "repo_path": str(row["repo_path"] or ""),
        "repo_url": str(row["repo_url"] or ""),
        "branch": str(row["branch"] or ""),
        "commit_sha": str(row["commit_sha"] or ""),
        "base_commit_sha": str(row["base_commit_sha"] or ""),
        "trigger_source": str(row["trigger_source"] or ""),
        "risk_level": str(row["risk_level"] or "unknown"),
        "status": str(row["status"] or "completed"),
        "summary": summary,
        "created_at": str(row["created_at"] or ""),
        "updated_at": str(row["updated_at"] or ""),
    }


def get_impact_analysis_run(job_id: str) -> dict[str, Any] | None:
    jid = str(job_id or "").strip()
    if not jid:
        return None
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            row = conn.execute(
                "SELECT * FROM impact_analysis_runs WHERE job_id=?",
                (jid,),
            ).fetchone()
        finally:
            conn.close()
    if not row:
        return None
    return _row_to_run(row)


def list_impact_analysis_runs(project_id: str, *, limit: int = 20, offset: int = 0) -> tuple[int, list[dict[str, Any]]]:
    pid = str(project_id or "").strip()
    if not pid:
        return 0, []
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            total_row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM impact_analysis_runs WHERE project_id=?",
                (pid,),
            ).fetchone()
            rows = conn.execute(
                """
                SELECT * FROM impact_analysis_runs
                WHERE project_id=?
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                (pid, int(limit), int(offset)),
            ).fetchall()
        finally:
            conn.close()
    total = int((total_row["cnt"] if total_row else 0) or 0)
    return total, [_row_to_run(row) for row in rows]
