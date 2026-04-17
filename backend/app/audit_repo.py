from __future__ import annotations

import json
import logging
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_store: "AuditRepo | None" = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class AuditRepo:
    """SQLite 持久化审计事件。"""

    _MAX_PAYLOAD_CHARS = 16000

    def __init__(self, db_path: Path, *, retention_days: int = 90):
        self.db_path = db_path
        self.retention_days = max(1, int(retention_days or 90))
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            try:
                self._conn.execute("PRAGMA journal_mode=WAL;")
                self._conn.execute("PRAGMA busy_timeout=8000;")
            except Exception as e:
                logger.warning("Audit SQLite PRAGMA (WAL/busy_timeout) failed: %s", e)
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS audit_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    route TEXT NOT NULL,
                    method TEXT NOT NULL,
                    resource_type TEXT NOT NULL,
                    resource_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    ip TEXT NOT NULL DEFAULT '',
                    user_agent TEXT NOT NULL DEFAULT ''
                )
                """
            )
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at DESC)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_events(event_type)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events(resource_type, resource_id)")
            self._conn.commit()
            self._purge_expired_events_locked()

    def _purge_before_iso(self) -> str:
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.retention_days)
        return cutoff.isoformat()

    def _purge_expired_events_locked(self) -> int:
        cursor = self._conn.execute(
            "DELETE FROM audit_events WHERE created_at < ?",
            (self._purge_before_iso(),),
        )
        deleted = int(cursor.rowcount or 0)
        if deleted > 0:
            logger.info("purged %s expired audit events", deleted)
        return deleted

    def purge_expired_events(self) -> int:
        with self._lock:
            deleted = self._purge_expired_events_locked()
            if deleted > 0:
                self._conn.commit()
            return deleted

    def append_event(
        self,
        *,
        event_type: str,
        actor: str,
        route: str,
        method: str,
        resource_type: str,
        resource_id: str = "",
        status: str = "ok",
        payload: dict[str, Any] | None = None,
        ip: str = "",
        user_agent: str = "",
    ) -> bool:
        try:
            payload_json = json.dumps(payload or {}, ensure_ascii=False)
        except Exception:
            payload_json = "{}"
        if len(payload_json) > self._MAX_PAYLOAD_CHARS:
            payload_json = payload_json[: self._MAX_PAYLOAD_CHARS]
        row = (
            _utc_now_iso(),
            str(event_type or "").strip(),
            str(actor or "").strip() or "anonymous",
            str(route or "").strip(),
            str(method or "").strip().upper(),
            str(resource_type or "").strip(),
            str(resource_id or "").strip(),
            str(status or "").strip(),
            payload_json,
            str(ip or "").strip(),
            str(user_agent or "").strip()[:512],
        )
        if not row[1] or not row[5]:
            return False
        with self._lock:
            self._purge_expired_events_locked()
            self._conn.execute(
                """
                INSERT INTO audit_events
                    (created_at, event_type, actor, route, method, resource_type, resource_id, status, payload_json, ip, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                row,
            )
            self._conn.commit()
        return True

    def list_events(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        event_type: str | None = None,
        actor: str | None = None,
        resource_type: str | None = None,
        resource_id: str | None = None,
        status: str | None = None,
        created_from: str | None = None,
        created_to: str | None = None,
    ) -> tuple[int, list[dict[str, Any]]]:
        where: list[str] = []
        params: list[Any] = []
        if event_type:
            where.append("event_type=?")
            params.append(event_type)
        if actor:
            where.append("actor=?")
            params.append(actor)
        if resource_type:
            where.append("resource_type=?")
            params.append(resource_type)
        if resource_id:
            where.append("resource_id=?")
            params.append(resource_id)
        if status:
            where.append("status=?")
            params.append(status)
        if created_from:
            where.append("created_at>=?")
            params.append(created_from)
        if created_to:
            where.append("created_at<=?")
            params.append(created_to)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        with self._lock:
            total_row = self._conn.execute(
                f"SELECT COUNT(*) AS cnt FROM audit_events {where_sql}",
                tuple(params),
            ).fetchone()
            rows = self._conn.execute(
                f"""
                SELECT id, created_at, event_type, actor, route, method, resource_type, resource_id, status, payload_json, ip, user_agent
                FROM audit_events
                {where_sql}
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                tuple(params + [int(limit), int(offset)]),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            payload = {}
            try:
                payload = json.loads(str(r["payload_json"] or "{}"))
                if not isinstance(payload, dict):
                    payload = {"raw": payload}
            except Exception:
                payload = {}
            out.append(
                {
                    "id": int(r["id"]),
                    "created_at": str(r["created_at"] or ""),
                    "event_type": str(r["event_type"] or ""),
                    "actor": str(r["actor"] or ""),
                    "route": str(r["route"] or ""),
                    "method": str(r["method"] or ""),
                    "resource_type": str(r["resource_type"] or ""),
                    "resource_id": str(r["resource_id"] or ""),
                    "status": str(r["status"] or ""),
                    "payload": payload,
                    "ip": str(r["ip"] or ""),
                    "user_agent": str(r["user_agent"] or ""),
                }
            )
        total = int((total_row["cnt"] if total_row else 0) or 0)
        return total, out

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass


def get_audit_repo() -> AuditRepo:
    global _store
    if _store is None:
        from app.config import settings

        db_path = settings.data_path / "audit_events.sqlite3"
        _store = AuditRepo(db_path, retention_days=settings.audit_retention_days)
    return _store


def append_audit_event(**kwargs: Any) -> bool:
    """旁路审计写入：失败仅告警，不影响主流程。"""
    try:
        return get_audit_repo().append_event(**kwargs)
    except Exception as e:  # noqa: S110
        logger.warning("append_audit_event failed: %s", e)
        return False
