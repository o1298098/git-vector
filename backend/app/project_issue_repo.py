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
    return settings.data_path / "project_issues.sqlite3"


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_column(conn: sqlite3.Connection, name: str, definition: str) -> None:
    cols = conn.execute("PRAGMA table_info(project_issues)").fetchall()
    if any(str(col[1]) == name for col in cols):
        return
    conn.execute(f"ALTER TABLE project_issues ADD COLUMN {name} {definition}")


def _init(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=8000;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_issues (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            issue_number TEXT NOT NULL,
            issue_url TEXT NOT NULL DEFAULT '',
            repo_url TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            author TEXT NOT NULL DEFAULT '',
            labels_json TEXT NOT NULL DEFAULT '[]',
            action TEXT NOT NULL DEFAULT 'opened',
            comments_json TEXT NOT NULL DEFAULT '[]',
            messages_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'open',
            latest_reply_job_id TEXT NOT NULL DEFAULT '',
            latest_reply_status TEXT NOT NULL DEFAULT '',
            latest_reply_preview TEXT NOT NULL DEFAULT '',
            latest_reply_posted_at TEXT NOT NULL DEFAULT '',
            latest_reply_comment_url TEXT NOT NULL DEFAULT '',
            latest_reply_error TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(project_id, provider, issue_number)
        )
        """
    )
    _ensure_column(conn, "messages_json", "TEXT NOT NULL DEFAULT '[]'")
    _ensure_column(conn, "latest_reply_posted_at", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "latest_reply_comment_url", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "latest_reply_error", "TEXT NOT NULL DEFAULT ''")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_issues_project_updated ON project_issues(project_id, updated_at DESC)"
    )
    conn.commit()


def _parse_json_list(raw: str) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except Exception:
        value = []
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if text:
            out.append(text)
    return out


def _parse_messages_json(raw: str) -> list[dict[str, Any]]:
    try:
        value = json.loads(raw or "[]")
    except Exception:
        value = []
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        message_id = str(item.get("id") or "").strip()
        role = str(item.get("role") or "user").strip().lower() or "user"
        kind = str(item.get("kind") or "comment").strip().lower() or "comment"
        author = str(item.get("author") or item.get("sender") or "").strip()
        body = str(item.get("body") or item.get("content") or "")
        created_at = str(item.get("created_at") or item.get("time") or "").strip()
        if not body.strip():
            continue
        out.append(
            {
                "id": message_id,
                "role": role if role in {"user", "assistant"} else "user",
                "kind": kind,
                "author": author,
                "body": body,
                "created_at": created_at,
                "url": str(item.get("url") or "").strip(),
                "provider": str(item.get("provider") or "").strip(),
                "source": str(item.get("source") or "").strip(),
                "status": str(item.get("status") or "").strip(),
            }
        )
    return out


def _normalize_status(action: str, provided_status: str = "") -> str:
    status = str(provided_status or "").strip().lower()
    if status in {"open", "opened", "reopened", "active", "todo"}:
        return "open"
    if status in {"closed", "close", "resolved", "done", "deleted"}:
        return "closed"
    if status:
        return status
    action_text = str(action or "").strip().lower()
    if action_text in {"close", "closed", "delete", "deleted", "resolve", "resolved"}:
        return "closed"
    if action_text in {"reopened", "opened", "created", "create", "edited", "updated", "opened_by_user"}:
        return "open"
    return "open"


def _sort_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def key(message: dict[str, Any]) -> tuple[str, str]:
        return (str(message.get("created_at") or ""), str(message.get("id") or ""))

    return sorted(messages, key=key)


def _merge_messages(existing: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_fallback: set[tuple[str, str, str, str]] = set()
    for message in [*existing, *incoming]:
        message_id = str(message.get("id") or "").strip()
        fallback_key = (
            str(message.get("role") or "").strip(),
            str(message.get("kind") or "").strip(),
            str(message.get("author") or "").strip(),
            str(message.get("body") or "").strip(),
        )
        if message_id:
            if message_id in seen_ids:
                continue
            seen_ids.add(message_id)
        elif fallback_key in seen_fallback:
            continue
        seen_fallback.add(fallback_key)
        merged.append(message)
    return _sort_messages(merged)


def _build_message_entries(payload: dict[str, Any], *, fallback_created_at: str) -> list[dict[str, Any]]:
    provider = str(payload.get("provider") or "generic").strip().lower() or "generic"
    issue_number = str(payload.get("issue_number") or payload.get("iid") or "").strip()
    issue_url = str(payload.get("issue_url") or payload.get("web_url") or "").strip()
    issue_title = str(payload.get("title") or "").strip()
    issue_author = str(payload.get("issue_author") or payload.get("author") or payload.get("user") or "").strip()
    comment_author = str(payload.get("comment_author") or payload.get("author") or payload.get("user") or "").strip()
    event_kind = str(payload.get("event_kind") or "issue").strip().lower() or "issue"
    issue_body = str(payload.get("issue_body") or payload.get("body") or payload.get("description") or "")
    comment_body = str(payload.get("comment_body") or "")
    issue_created_at = str(payload.get("issue_created_at") or payload.get("created_at") or fallback_created_at).strip() or fallback_created_at
    event_created_at = str(payload.get("event_created_at") or issue_created_at or fallback_created_at).strip() or fallback_created_at
    comment_url = str(payload.get("comment_url") or "").strip()
    comment_id = str(payload.get("comment_id") or "").strip()
    reply_id = str(payload.get("reply_id") or "").strip()
    source = str(payload.get("source") or "webhook").strip() or "webhook"
    status = str(payload.get("message_status") or payload.get("status") or "").strip()

    if event_kind == "reply":
        text = str(payload.get("reply_body") or payload.get("body") or "")
        if not text.strip():
            return []
        return [
            {
                "id": reply_id or f"{provider}:reply:{issue_number}:{event_created_at}:{hash(text.strip())}",
                "role": "assistant",
                "kind": "reply",
                "author": str(payload.get("reply_author") or payload.get("author") or "bot").strip() or "bot",
                "body": text,
                "created_at": event_created_at,
                "url": comment_url,
                "provider": provider,
                "source": source,
                "status": status,
            }
        ]

    if event_kind == "comment":
        if not comment_body.strip():
            return []
        return [
            {
                "id": comment_id or f"{provider}:comment:{issue_number}:{event_created_at}:{hash(comment_body.strip())}",
                "role": "user",
                "kind": "comment",
                "author": comment_author,
                "body": comment_body,
                "created_at": event_created_at,
                "url": comment_url or issue_url,
                "provider": provider,
                "source": source,
                "status": status,
            }
        ]

    if not str(issue_body or "").strip() and not issue_title:
        return []
    return [
        {
            "id": f"{provider}:issue:{issue_number}",
            "role": "user",
            "kind": "issue_body",
            "author": issue_author,
            "body": issue_body if str(issue_body or "").strip() else issue_title,
            "created_at": issue_created_at,
            "url": issue_url,
            "provider": provider,
            "source": source,
            "status": status,
        }
    ]


def _messages_to_comments(messages: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for message in messages:
        if str(message.get("kind") or "") != "comment":
            continue
        text = str(message.get("body") or "").strip()
        if text:
            out.append(text)
    return out


def _row_to_issue(row: sqlite3.Row) -> dict[str, Any]:
    messages = _parse_messages_json(str(row["messages_json"] or "[]"))
    return {
        "id": int(row["id"] or 0),
        "project_id": str(row["project_id"] or "").strip(),
        "provider": str(row["provider"] or "").strip(),
        "issue_number": str(row["issue_number"] or "").strip(),
        "issue_url": str(row["issue_url"] or "").strip(),
        "repo_url": str(row["repo_url"] or "").strip(),
        "title": str(row["title"] or "").strip(),
        "body": str(row["body"] or ""),
        "author": str(row["author"] or "").strip(),
        "labels": _parse_json_list(str(row["labels_json"] or "[]")),
        "action": str(row["action"] or "").strip(),
        "comments": _parse_json_list(str(row["comments_json"] or "[]")),
        "messages": messages,
        "status": str(row["status"] or "").strip(),
        "latest_reply_job_id": str(row["latest_reply_job_id"] or "").strip(),
        "latest_reply_status": str(row["latest_reply_status"] or "").strip(),
        "latest_reply_preview": str(row["latest_reply_preview"] or ""),
        "latest_reply_posted_at": str(row["latest_reply_posted_at"] or "").strip(),
        "latest_reply_comment_url": str(row["latest_reply_comment_url"] or "").strip(),
        "latest_reply_error": str(row["latest_reply_error"] or ""),
        "created_at": str(row["created_at"] or "").strip(),
        "updated_at": str(row["updated_at"] or "").strip(),
    }


def upsert_project_issue(*, payload: dict[str, Any]) -> dict[str, Any]:
    project_id = str(payload.get("project_id") or "").strip()
    provider = str(payload.get("provider") or "generic").strip().lower() or "generic"
    issue_number = str(payload.get("issue_number") or payload.get("iid") or "").strip()
    if not project_id or not issue_number:
        raise ValueError("project_id and issue_number are required")
    now = _utc_now_iso()
    issue_url = str(payload.get("issue_url") or payload.get("web_url") or "").strip()
    repo_url = str(payload.get("repo_url") or "").strip()
    title = str(payload.get("title") or "").strip()
    body = str(payload.get("issue_body") or payload.get("body") or payload.get("description") or "")
    author = str(payload.get("issue_author") or payload.get("author") or payload.get("user") or "").strip()
    labels = [str(x).strip() for x in (payload.get("labels") or []) if str(x).strip()]
    action = str(payload.get("action") or "opened").strip().lower() or "opened"
    raw_status = str(payload.get("status") or "").strip()
    status = _normalize_status(action, raw_status)

    with _lock:
        conn = _conn()
        try:
            _init(conn)
            existing = conn.execute(
                "SELECT * FROM project_issues WHERE project_id=? AND provider=? AND issue_number=?",
                (project_id, provider, issue_number),
            ).fetchone()
            existing_status = str(existing["status"] or "").strip().lower() if existing else ""
            existing_action = str(existing["action"] or "").strip().lower() if existing else ""
            if existing_status == "closed" and not raw_status and action in {"update", "updated", "edit", "edited", "comment_create", "comment_created", "comment_add"}:
                status = "closed"
                if action in {"comment_create", "comment_created", "comment_add"}:
                    action = existing_action or action
            existing_messages = _parse_messages_json(str(existing["messages_json"] or "[]")) if existing else []
            incoming_messages = _build_message_entries(payload, fallback_created_at=now)
            merged_messages = _merge_messages(existing_messages, incoming_messages)
            comments = _messages_to_comments(merged_messages)
            messages_json = json.dumps(merged_messages, ensure_ascii=False)
            comments_json = json.dumps(comments, ensure_ascii=False)
            created_at = str(existing["created_at"] or now).strip() if existing else now
            updated_at = now
            conn.execute(
                """
                INSERT INTO project_issues (
                    project_id, provider, issue_number, issue_url, repo_url, title, body, author,
                    labels_json, action, comments_json, messages_json, status, latest_reply_job_id, latest_reply_status,
                    latest_reply_preview, latest_reply_posted_at, latest_reply_comment_url, latest_reply_error,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', '', '', '', ?, ?)
                ON CONFLICT(project_id, provider, issue_number) DO UPDATE SET
                    issue_url=excluded.issue_url,
                    repo_url=excluded.repo_url,
                    title=excluded.title,
                    body=CASE WHEN TRIM(COALESCE(excluded.body, '')) != '' THEN excluded.body ELSE project_issues.body END,
                    author=CASE WHEN TRIM(COALESCE(excluded.author, '')) != '' THEN excluded.author ELSE project_issues.author END,
                    labels_json=excluded.labels_json,
                    action=CASE
                        WHEN project_issues.status='closed' AND excluded.status='closed' AND excluded.action IN ('comment_create', 'comment_created', 'comment_add')
                            THEN project_issues.action
                        ELSE excluded.action
                    END,
                    comments_json=excluded.comments_json,
                    messages_json=excluded.messages_json,
                    status=CASE
                        WHEN project_issues.status='closed' AND excluded.status='open' AND excluded.action IN ('comment_create', 'comment_created', 'comment_add', 'update', 'updated', 'edit', 'edited')
                            THEN project_issues.status
                        ELSE excluded.status
                    END,
                    updated_at=excluded.updated_at
                """,
                (
                    project_id,
                    provider,
                    issue_number,
                    issue_url,
                    repo_url,
                    title,
                    body,
                    author,
                    json.dumps(labels, ensure_ascii=False),
                    action,
                    comments_json,
                    messages_json,
                    status,
                    created_at,
                    updated_at,
                ),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM project_issues WHERE project_id=? AND provider=? AND issue_number=?",
                (project_id, provider, issue_number),
            ).fetchone()
        finally:
            conn.close()
    if not row:
        raise RuntimeError("failed to upsert project issue")
    return _row_to_issue(row)


def append_issue_message(
    *,
    project_id: str,
    provider: str,
    issue_number: str,
    message: dict[str, Any],
) -> bool:
    pid = str(project_id or "").strip()
    prov = str(provider or "generic").strip().lower() or "generic"
    num = str(issue_number or "").strip()
    if not pid or not num:
        return False
    now = _utc_now_iso()
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            row = conn.execute(
                "SELECT * FROM project_issues WHERE project_id=? AND provider=? AND issue_number=?",
                (pid, prov, num),
            ).fetchone()
            if not row:
                return False
            existing_messages = _parse_messages_json(str(row["messages_json"] or "[]"))
            merged_messages = _merge_messages(existing_messages, [message])
            comments_json = json.dumps(_messages_to_comments(merged_messages), ensure_ascii=False)
            messages_json = json.dumps(merged_messages, ensure_ascii=False)
            cur = conn.execute(
                """
                UPDATE project_issues
                SET messages_json=?, comments_json=?, updated_at=?
                WHERE project_id=? AND provider=? AND issue_number=?
                """,
                (messages_json, comments_json, now, pid, prov, num),
            )
            conn.commit()
            return int(cur.rowcount or 0) > 0
        finally:
            conn.close()


def update_issue_reply_state(
    *,
    project_id: str,
    provider: str,
    issue_number: str,
    latest_reply_job_id: str = "",
    latest_reply_status: str = "",
    latest_reply_preview: str = "",
    latest_reply_posted_at: str = "",
    latest_reply_comment_url: str = "",
    latest_reply_error: str = "",
) -> bool:
    pid = str(project_id or "").strip()
    prov = str(provider or "generic").strip().lower() or "generic"
    num = str(issue_number or "").strip()
    if not pid or not num:
        return False
    now = _utc_now_iso()
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            cur = conn.execute(
                """
                UPDATE project_issues
                SET latest_reply_job_id=?, latest_reply_status=?, latest_reply_preview=?,
                    latest_reply_posted_at=?, latest_reply_comment_url=?, latest_reply_error=?, updated_at=?
                WHERE project_id=? AND provider=? AND issue_number=?
                """,
                (
                    latest_reply_job_id,
                    latest_reply_status,
                    latest_reply_preview[:1000],
                    latest_reply_posted_at,
                    latest_reply_comment_url,
                    latest_reply_error[:1000],
                    now,
                    pid,
                    prov,
                    num,
                ),
            )
            conn.commit()
            return int(cur.rowcount or 0) > 0
        finally:
            conn.close()


def list_project_issues(project_id: str, *, limit: int = 20, offset: int = 0) -> tuple[int, list[dict[str, Any]]]:
    pid = str(project_id or "").strip()
    if not pid:
        return 0, []
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            total_row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM project_issues WHERE project_id=?",
                (pid,),
            ).fetchone()
            rows = conn.execute(
                """
                SELECT * FROM project_issues
                WHERE project_id=?
                ORDER BY updated_at DESC, id DESC
                LIMIT ? OFFSET ?
                """,
                (pid, int(limit), int(offset)),
            ).fetchall()
        finally:
            conn.close()
    total = int((total_row["cnt"] if total_row else 0) or 0)
    return total, [_row_to_issue(row) for row in rows]


def get_project_issue(project_id: str, provider: str, issue_number: str) -> dict[str, Any] | None:
    pid = str(project_id or "").strip()
    prov = str(provider or "generic").strip().lower() or "generic"
    num = str(issue_number or "").strip()
    if not pid or not num:
        return None
    with _lock:
        conn = _conn()
        try:
            _init(conn)
            row = conn.execute(
                "SELECT * FROM project_issues WHERE project_id=? AND provider=? AND issue_number=?",
                (pid, prov, num),
            ).fetchone()
        finally:
            conn.close()
    return _row_to_issue(row) if row else None
