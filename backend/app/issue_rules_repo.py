from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings

_lock = threading.Lock()
_DEFAULT_BLOCKED = [
    "security",
    "vulnerability",
    "legal",
    "invoice",
    "billing",
    "privacy",
    "gdpr",
    "password",
    "credential",
    "secret",
]
_DEFAULT_HUMAN = ["urgent", "production", "outage", "refund", "data loss"]
_DEFAULT_AVAILABLE_LABELS = ["bug", "enhancement", "question", "documentation", "needs-human", "blocked"]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> Path:
    return settings.data_path / "issue_reply_rules.sqlite3"


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _init(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=8000;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS issue_reply_rules (
            project_id TEXT PRIMARY KEY,
            auto_post_default INTEGER NOT NULL DEFAULT 0,
            blocked_keywords_json TEXT NOT NULL DEFAULT '[]',
            require_human_keywords_json TEXT NOT NULL DEFAULT '[]',
            reply_template TEXT NOT NULL DEFAULT '',
            reply_requirements TEXT NOT NULL DEFAULT '',
            auto_label_enabled INTEGER NOT NULL DEFAULT 0,
            auto_apply_labels INTEGER NOT NULL DEFAULT 0,
            available_labels_json TEXT NOT NULL DEFAULT '[]',
            labeling_instructions TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        )
        """
    )
    cols = {row[1] for row in conn.execute("PRAGMA table_info(issue_reply_rules)").fetchall()}
    if "reply_template" not in cols:
        conn.execute("ALTER TABLE issue_reply_rules ADD COLUMN reply_template TEXT NOT NULL DEFAULT ''")
    if "reply_requirements" not in cols:
        conn.execute("ALTER TABLE issue_reply_rules ADD COLUMN reply_requirements TEXT NOT NULL DEFAULT ''")
    if "auto_label_enabled" not in cols:
        conn.execute("ALTER TABLE issue_reply_rules ADD COLUMN auto_label_enabled INTEGER NOT NULL DEFAULT 0")
    if "auto_apply_labels" not in cols:
        conn.execute("ALTER TABLE issue_reply_rules ADD COLUMN auto_apply_labels INTEGER NOT NULL DEFAULT 0")
    if "available_labels_json" not in cols:
        conn.execute("ALTER TABLE issue_reply_rules ADD COLUMN available_labels_json TEXT NOT NULL DEFAULT '[]'")
    if "labeling_instructions" not in cols:
        conn.execute("ALTER TABLE issue_reply_rules ADD COLUMN labeling_instructions TEXT NOT NULL DEFAULT ''")
    conn.commit()


def _parse_keywords(raw: str, fallback: list[str]) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except Exception:
        value = fallback
    if not isinstance(value, list):
        value = fallback
    normalized: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = str(item or "").strip()
        lowered = text.lower()
        if not text or lowered in seen:
            continue
        seen.add(lowered)
        normalized.append(text)
    return normalized


def default_issue_reply_rules(project_id: str) -> dict[str, Any]:
    return {
        "project_id": str(project_id or "").strip(),
        "auto_post_default": False,
        "blocked_keywords": list(_DEFAULT_BLOCKED),
        "require_human_keywords": list(_DEFAULT_HUMAN),
        "reply_template": "",
        "reply_requirements": "",
        "auto_label_enabled": False,
        "auto_apply_labels": True,
        "available_labels": list(_DEFAULT_AVAILABLE_LABELS),
        "labeling_instructions": "",
        "updated_at": "",
    }


def get_issue_reply_rules(project_id: str) -> dict[str, Any]:
    pid = str(project_id or "").strip()
    defaults = default_issue_reply_rules(pid)
    if not pid:
        return defaults
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            row = conn.execute("SELECT * FROM issue_reply_rules WHERE project_id=?", (pid,)).fetchone()
        finally:
            conn.close()
    if not row:
        return defaults
    return {
        "project_id": pid,
        "auto_post_default": bool(int(row["auto_post_default"] or 0)),
        "blocked_keywords": _parse_keywords(str(row["blocked_keywords_json"] or "[]"), defaults["blocked_keywords"]),
        "require_human_keywords": _parse_keywords(
            str(row["require_human_keywords_json"] or "[]"), defaults["require_human_keywords"]
        ),
        "reply_template": str(row["reply_template"] or ""),
        "reply_requirements": str(row["reply_requirements"] or ""),
        "auto_label_enabled": bool(int(row["auto_label_enabled"] or 0)),
        "auto_apply_labels": bool(int(row["auto_apply_labels"] or 0)),
        "available_labels": _parse_keywords(str(row["available_labels_json"] or "[]"), defaults["available_labels"]),
        "labeling_instructions": str(row["labeling_instructions"] or ""),
        "updated_at": str(row["updated_at"] or ""),
    }


def save_issue_reply_rules(
    *,
    project_id: str,
    auto_post_default: bool,
    blocked_keywords: list[str],
    require_human_keywords: list[str],
    reply_template: str = "",
    reply_requirements: str = "",
    auto_label_enabled: bool = False,
    auto_apply_labels: bool = False,
    available_labels: list[str] | None = None,
    labeling_instructions: str = "",
) -> dict[str, Any]:
    pid = str(project_id or "").strip()
    if not pid:
        raise ValueError("project_id is required")
    blocked = _parse_keywords(json.dumps(blocked_keywords, ensure_ascii=False), _DEFAULT_BLOCKED)
    require_human = _parse_keywords(json.dumps(require_human_keywords, ensure_ascii=False), _DEFAULT_HUMAN)
    normalized_available_labels = _parse_keywords(
        json.dumps(available_labels or [], ensure_ascii=False),
        _DEFAULT_AVAILABLE_LABELS,
    )
    now = _utc_now_iso()
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            conn.execute(
                """
                INSERT INTO issue_reply_rules (
                    project_id,
                    auto_post_default,
                    blocked_keywords_json,
                    require_human_keywords_json,
                    reply_template,
                    reply_requirements,
                    auto_label_enabled,
                    auto_apply_labels,
                    available_labels_json,
                    labeling_instructions,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    auto_post_default=excluded.auto_post_default,
                    blocked_keywords_json=excluded.blocked_keywords_json,
                    require_human_keywords_json=excluded.require_human_keywords_json,
                    reply_template=excluded.reply_template,
                    reply_requirements=excluded.reply_requirements,
                    auto_label_enabled=excluded.auto_label_enabled,
                    auto_apply_labels=excluded.auto_apply_labels,
                    available_labels_json=excluded.available_labels_json,
                    labeling_instructions=excluded.labeling_instructions,
                    updated_at=excluded.updated_at
                """,
                (
                    pid,
                    1 if auto_post_default else 0,
                    json.dumps(blocked, ensure_ascii=False),
                    json.dumps(require_human, ensure_ascii=False),
                    str(reply_template or "").strip(),
                    str(reply_requirements or "").strip(),
                    1 if auto_label_enabled else 0,
                    1 if auto_apply_labels else 0,
                    json.dumps(normalized_available_labels, ensure_ascii=False),
                    str(labeling_instructions or "").strip(),
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    return get_issue_reply_rules(pid)
