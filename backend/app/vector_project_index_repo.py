from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

from app.config import settings

_project_index_db_lock = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _project_index_db_path() -> str:
    # 独立一个小库，避免与 index_jobs.sqlite3 的写入争用
    return str(settings.data_path / "project_index.sqlite3")


def _init_project_index_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_index (
            project_id TEXT PRIMARY KEY,
            doc_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )
        """
    )
    cols = {row[1] for row in conn.execute("PRAGMA table_info(project_index)").fetchall()}
    if "project_name" not in cols:
        conn.execute("ALTER TABLE project_index ADD COLUMN project_name TEXT NOT NULL DEFAULT ''")
    if "last_indexed_commit" not in cols:
        conn.execute("ALTER TABLE project_index ADD COLUMN last_indexed_commit TEXT NOT NULL DEFAULT ''")
    if "last_embed_model" not in cols:
        conn.execute("ALTER TABLE project_index ADD COLUMN last_embed_model TEXT NOT NULL DEFAULT ''")
    conn.commit()


def _read_project_index_from_db() -> list[dict[str, Any]]:
    db_path = _project_index_db_path()
    with _project_index_db_lock:
        conn = sqlite3.connect(db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            _init_project_index_db(conn)
            rows = conn.execute(
                """
                SELECT project_id, doc_count,
                       COALESCE(project_name, '') AS project_name
                FROM project_index
                ORDER BY project_id ASC
                """
            ).fetchall()
            return [
                {
                    "project_id": r["project_id"],
                    "doc_count": int(r["doc_count"]),
                    "project_name": (r["project_name"] or "").strip(),
                }
                for r in rows
            ]
        finally:
            conn.close()


def _project_index_row_exists(project_id: str) -> bool:
    db_path = _project_index_db_path()
    with _project_index_db_lock:
        conn = sqlite3.connect(db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            _init_project_index_db(conn)
            row = conn.execute(
                "SELECT 1 AS ok FROM project_index WHERE project_id=? LIMIT 1",
                (project_id,),
            ).fetchone()
            return row is not None
        finally:
            conn.close()


def _delete_project_index_row(project_id: str) -> None:
    db_path = _project_index_db_path()
    with _project_index_db_lock:
        conn = sqlite3.connect(db_path, check_same_thread=False)
        try:
            _init_project_index_db(conn)
            conn.execute("DELETE FROM project_index WHERE project_id=?", (project_id,))
            conn.commit()
        finally:
            conn.close()


def get_project_index_meta(project_id: str) -> dict[str, Any] | None:
    """读取 project_index 行（含增量索引用的 commit / 嵌入模型记录）。"""
    pid = str(project_id or "").strip()
    if not pid:
        return None
    db_path = _project_index_db_path()
    with _project_index_db_lock:
        conn = sqlite3.connect(db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            _init_project_index_db(conn)
            row = conn.execute(
                """
                SELECT project_id, doc_count, project_name,
                       COALESCE(last_indexed_commit, '') AS last_indexed_commit,
                       COALESCE(last_embed_model, '') AS last_embed_model
                FROM project_index WHERE project_id=?
                """,
                (pid,),
            ).fetchone()
        finally:
            conn.close()
    if not row:
        return None
    return {
        "project_id": str(row["project_id"]),
        "doc_count": int(row["doc_count"]),
        "project_name": (row["project_name"] or "").strip(),
        "last_indexed_commit": str(row["last_indexed_commit"] or "").strip(),
        "last_embed_model": str(row["last_embed_model"] or "").strip(),
    }


def resolve_project_display_name_for_enqueue(project_id: str, incoming: str) -> str:
    """
    自动化入队（如 GitLab/GitHub push Webhook）使用的展示名解析。

    若 ``project_index`` 中已有非空 ``project_name``（通常来自用户在概览里 PATCH 的展示名），
    则优先复用，避免托管方事件里的仓库短名写入新任务，进而覆盖列表与 ``latest`` 展示逻辑。
    """
    pid = str(project_id or "").strip()
    inc = (incoming or "").strip()
    if not pid:
        return inc
    meta = get_project_index_meta(pid)
    saved = str((meta or {}).get("project_name") or "").strip()
    return saved if saved else inc


def _upsert_project_index_in_db(
    project_id: str,
    doc_count: int,
    project_name: str = "",
    *,
    last_indexed_commit: str = "",
    last_embed_model: str = "",
) -> None:
    pname = (project_name or "").strip()
    lc = (last_indexed_commit or "").strip()
    em = (last_embed_model or "").strip()
    now = _utc_now_iso()
    db_path = _project_index_db_path()
    with _project_index_db_lock:
        conn = sqlite3.connect(db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            _init_project_index_db(conn)
            conn.execute(
                """
                INSERT INTO project_index
                    (project_id, doc_count, updated_at, project_name, last_indexed_commit, last_embed_model)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    doc_count = excluded.doc_count,
                    updated_at = excluded.updated_at,
                    project_name = CASE
                        WHEN TRIM(excluded.project_name) != '' THEN TRIM(excluded.project_name)
                        ELSE project_index.project_name
                    END,
                    last_indexed_commit = CASE
                        WHEN TRIM(excluded.last_indexed_commit) != '' THEN TRIM(excluded.last_indexed_commit)
                        ELSE project_index.last_indexed_commit
                    END,
                    last_embed_model = CASE
                        WHEN TRIM(excluded.last_embed_model) != '' THEN TRIM(excluded.last_embed_model)
                        ELSE project_index.last_embed_model
                    END
                """,
                (project_id, int(doc_count), now, pname, lc, em),
            )
            conn.commit()
        finally:
            conn.close()


def _replace_project_index_in_db(project_stats: dict[str, int]) -> None:
    db_path = _project_index_db_path()
    with _project_index_db_lock:
        conn = sqlite3.connect(db_path, check_same_thread=False)
        try:
            _init_project_index_db(conn)
            conn.execute("DELETE FROM project_index")
            conn.executemany(
                """
                INSERT INTO project_index
                    (project_id, doc_count, updated_at, project_name, last_indexed_commit, last_embed_model)
                VALUES (?, ?, ?, '', '', '')
                """,
                [(pid, int(count), _utc_now_iso()) for pid, count in project_stats.items()],
            )
            conn.commit()
        finally:
            conn.close()


def set_project_display_name(project_id: str, project_name: str) -> bool:
    """仅更新 project_index 中的展示名，不改变 doc_count；无对应行则返回 False。"""
    pid = str(project_id or "").strip()
    if not pid:
        return False
    pname = (project_name or "").strip()
    now = _utc_now_iso()
    db_path = _project_index_db_path()
    with _project_index_db_lock:
        conn = sqlite3.connect(db_path, check_same_thread=False)
        try:
            _init_project_index_db(conn)
            cur = conn.execute(
                "UPDATE project_index SET project_name=?, updated_at=? WHERE project_id=?",
                (pname, now, pid),
            )
            conn.commit()
            return int(cur.rowcount or 0) > 0
        finally:
            conn.close()
