from __future__ import annotations

import json
import logging
import multiprocessing as mp
import re
import sqlite3
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Iterable, Literal, Optional
from urllib.parse import quote, urlparse, urlunparse

from app.config import settings
from app.content_locale import (
    index_done_messages,
    index_generic_processing,
    index_parse_progress_msg,
    index_progress_messages,
)
from app.effective_settings import (
    detect_git_provider,
    effective_content_language,
    effective_git_https_token,
    effective_git_https_username,
)
from app.issue_reply_job_payload_repo import get_issue_reply_job_payload

logger = logging.getLogger(__name__)

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]

# 子进程必须用 spawn：父进程已打开 SQLite，fork 会继承非法连接状态
_mp_spawn = mp.get_context("spawn")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_repo_url(repo_url: str) -> str:
    """
    只保留“干净 URL”（不含用户名/密码/token），避免把凭据写进 DB / 接口返回 / 日志。
    - http(s)://user:token@host/path -> http(s)://host/path
    - 其他协议（ssh/git）原样返回
    """
    try:
        u = urlparse(repo_url)
    except Exception:
        return repo_url
    if u.scheme not in ("http", "https"):
        return repo_url
    # 去掉 netloc 里的 userinfo
    host = (u.hostname or "")
    if not host:
        return repo_url
    netloc = host
    if u.port:
        netloc = f"{host}:{u.port}"
    return urlunparse((u.scheme, netloc, u.path, u.params, u.query, u.fragment))


_CRED_URL_RE = re.compile(r"(https?://)([^/@:]+):([^@]+)@")


def sanitize_text(text: str) -> str:
    """对错误信息/日志片段里的 URL 凭据做打码。"""
    if not text:
        return text
    return _CRED_URL_RE.sub(r"\1****:****@", text)


def build_repo_url_for_clone(clean_repo_url: str) -> str:
    """
    执行 clone/pull 时再注入 token。
    仅当：
    - clean_repo_url 为 http(s)
    - effective_git_https_token() 有值（GIT_HTTPS_TOKEN 或 GITLAB_ACCESS_TOKEN / 界面覆盖）
    - URL 本身不包含 userinfo
    """
    token = (effective_git_https_token(clean_repo_url) or "").strip()
    if not token:
        return clean_repo_url
    try:
        u = urlparse(clean_repo_url)
    except Exception:
        return clean_repo_url
    if u.scheme not in ("http", "https"):
        return clean_repo_url
    # clean_url 理论上不应包含 username/password；有的话也不覆盖（尊重调用方）
    if u.username or u.password:
        return clean_repo_url
    host = (u.hostname or "")
    if not host:
        return clean_repo_url
    netloc = host
    if u.port:
        netloc = f"{host}:{u.port}"
    # token / 用户名可能含特殊字符，须编码
    provider = detect_git_provider(clean_repo_url)
    default_user = "x-access-token" if provider == "github" else "oauth2"
    user = (effective_git_https_username(clean_repo_url) or default_user).strip() or default_user
    user_enc = quote(user, safe="")
    token_enc = quote(token, safe="")
    netloc = f"{user_enc}:{token_enc}@{netloc}"

    # 多数托管方 HTTPS clone 兼容不带 .git；补全 .git 可减少重定向/鉴权边界问题
    path = u.path or ""
    if path and not path.endswith(".git"):
        path = path + ".git"
    return urlunparse((u.scheme, netloc, path, u.params, u.query, u.fragment))


@dataclass(frozen=True)
class IndexJob:
    job_id: str
    project_id: str
    repo_url: str  # 永远是干净 URL（不含凭据）
    project_name: str  # 展示用中文名等（可选，默认空）
    status: JobStatus
    progress: int
    step: str
    message: str
    created_at: str
    started_at: str
    finished_at: str
    failure_reason: str = ""
    log_excerpt: str = ""
    job_type: str = "index"
    payload_json: str = "{}"
    result_json: str = "{}"
    payload: dict[str, Any] = field(default_factory=dict, compare=False)
    result: dict[str, Any] = field(default_factory=dict, compare=False)


@dataclass(frozen=True)
class JobLogEntry:
    id: int
    job_id: str
    sequence: int
    created_at: str
    level: str
    step: str
    message: str
    source: str


class JobStore:
    """SQLite 持久化任务状态（单进程/单容器）。"""
    _MAX_LOG_CHARS = 6000

    def __init__(self, db_path: Path):
        self.db_path = db_path
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
                logger.warning("SQLite PRAGMA (WAL/busy_timeout) failed: %s", e)
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS index_jobs (
                    job_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    repo_url TEXT NOT NULL,
                    project_name TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    progress INTEGER NOT NULL,
                    step TEXT NOT NULL,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT NOT NULL,
                    failure_reason TEXT NOT NULL DEFAULT '',
                    log_excerpt TEXT NOT NULL DEFAULT '',
                    job_type TEXT NOT NULL DEFAULT 'index',
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    result_json TEXT NOT NULL DEFAULT '{}'
                )
                """
            )
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_index_jobs_status ON index_jobs(status)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_index_jobs_project ON index_jobs(project_id)")
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS job_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    level TEXT NOT NULL DEFAULT 'INFO',
                    step TEXT NOT NULL DEFAULT '',
                    message TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'job_queue',
                    FOREIGN KEY(job_id) REFERENCES index_jobs(job_id) ON DELETE CASCADE,
                    UNIQUE(job_id, sequence)
                )
                """
            )
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_job_logs_job_id_id ON job_logs(job_id, id)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_job_logs_job_id_sequence ON job_logs(job_id, sequence)")
            cols = {row[1] for row in self._conn.execute("PRAGMA table_info(index_jobs)")}
            if "project_name" not in cols:
                self._conn.execute(
                    "ALTER TABLE index_jobs ADD COLUMN project_name TEXT NOT NULL DEFAULT ''"
                )
            if "failure_reason" not in cols:
                self._conn.execute(
                    "ALTER TABLE index_jobs ADD COLUMN failure_reason TEXT NOT NULL DEFAULT ''"
                )
            if "log_excerpt" not in cols:
                self._conn.execute(
                    "ALTER TABLE index_jobs ADD COLUMN log_excerpt TEXT NOT NULL DEFAULT ''"
                )
            if "job_type" not in cols:
                self._conn.execute(
                    "ALTER TABLE index_jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'index'"
                )
            if "payload_json" not in cols:
                self._conn.execute(
                    "ALTER TABLE index_jobs ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'"
                )
            if "result_json" not in cols:
                self._conn.execute(
                    "ALTER TABLE index_jobs ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}'"
                )
            self._conn.commit()

    def create_job(
        self,
        project_id: str,
        repo_url: str,
        project_name: str = "",
        *,
        job_type: str = "index",
        payload: dict[str, Any] | str | None = None,
    ) -> IndexJob:
        job_id = str(uuid.uuid4())
        now = _utc_now_iso()
        clean_url = normalize_repo_url(repo_url)
        pname = (project_name or "").strip()
        if isinstance(payload, str):
            payload_json = payload or "{}"
            try:
                parsed_payload = json.loads(payload_json)
                payload_obj = parsed_payload if isinstance(parsed_payload, dict) else {"raw": parsed_payload}
            except Exception:
                payload_obj = {}
                payload_json = "{}"
        else:
            payload_obj = payload or {}
            try:
                payload_json = json.dumps(payload_obj, ensure_ascii=False)
            except Exception:
                payload_obj = {}
                payload_json = "{}"
        job = IndexJob(
            job_id=job_id,
            project_id=project_id,
            repo_url=clean_url,
            project_name=pname,
            status="queued",
            progress=0,
            step="queued",
            message="Queued",
            created_at=now,
            started_at="",
            finished_at="",
            failure_reason="",
            log_excerpt="",
            job_type=(job_type or "index").strip() or "index",
            payload_json=payload_json,
            result_json="{}",
            payload=payload_obj,
            result={},
        )
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO index_jobs
                (job_id, project_id, repo_url, project_name, status, progress, step, message, created_at, started_at, finished_at, failure_reason, log_excerpt, job_type, payload_json, result_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job.job_id,
                    job.project_id,
                    job.repo_url,
                    job.project_name,
                    job.status,
                    job.progress,
                    job.step,
                    job.message,
                    job.created_at,
                    job.started_at,
                    job.finished_at,
                    job.failure_reason,
                    job.log_excerpt,
                    job.job_type,
                    job.payload_json,
                    job.result_json,
                ),
            )
            self._conn.commit()
        return job

    def update_job_payload(self, job_id: str, payload: dict[str, Any] | str | None) -> None:
        if isinstance(payload, str):
            payload_json = payload or "{}"
            try:
                parsed_payload = json.loads(payload_json)
                payload_obj = parsed_payload if isinstance(parsed_payload, dict) else {"raw": parsed_payload}
            except Exception:
                payload_obj = {}
                payload_json = "{}"
        else:
            payload_obj = payload or {}
            try:
                payload_json = json.dumps(payload_obj, ensure_ascii=False)
            except Exception:
                payload_obj = {}
                payload_json = "{}"
        with self._lock:
            self._conn.execute("UPDATE index_jobs SET payload_json=? WHERE job_id=?", (payload_json, job_id))
            self._conn.commit()

    def update_job(
        self,
        job_id: str,
        *,
        status: Optional[JobStatus] = None,
        progress: Optional[int] = None,
        step: Optional[str] = None,
        message: Optional[str] = None,
        started_at: Optional[str] = None,
        finished_at: Optional[str] = None,
        failure_reason: Optional[str] = None,
        log_excerpt: Optional[str] = None,
        result: Optional[dict[str, Any]] = None,
    ) -> None:
        fields: list[str] = []
        values: list[Any] = []
        if status is not None:
            fields.append("status=?")
            values.append(status)
        if progress is not None:
            fields.append("progress=?")
            values.append(int(max(0, min(100, progress))))
        if step is not None:
            fields.append("step=?")
            values.append(step)
        if message is not None:
            fields.append("message=?")
            values.append(sanitize_text(message))
        if started_at is not None:
            fields.append("started_at=?")
            values.append(started_at)
        if finished_at is not None:
            fields.append("finished_at=?")
            values.append(finished_at)
        if failure_reason is not None:
            fields.append("failure_reason=?")
            values.append(sanitize_text(failure_reason))
        if log_excerpt is not None:
            fields.append("log_excerpt=?")
            values.append(sanitize_text(self._trim_log_excerpt(log_excerpt)))
        if result is not None:
            try:
                result_json = json.dumps(result, ensure_ascii=False)
            except Exception:
                result_json = "{}"
            fields.append("result_json=?")
            values.append(result_json)
        if not fields:
            return
        values.append(job_id)
        sql = f"UPDATE index_jobs SET {', '.join(fields)} WHERE job_id=?"
        with self._lock:
            self._conn.execute(sql, tuple(values))
            self._conn.commit()

    def _trim_log_excerpt(self, text: str) -> str:
        s = str(text or "")
        if len(s) <= self._MAX_LOG_CHARS:
            return s
        return s[-self._MAX_LOG_CHARS :]

    def _next_job_log_sequence(self, job_id: str) -> int:
        row = self._conn.execute(
            "SELECT COALESCE(MAX(sequence), 0) AS seq FROM job_logs WHERE job_id=?",
            (job_id,),
        ).fetchone()
        return int((row["seq"] if row else 0) or 0) + 1

    def list_job_logs(self, job_id: str, *, limit: int = 200, offset: int = 0) -> list[JobLogEntry]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, job_id, sequence, created_at, level, step, message, source
                FROM job_logs
                WHERE job_id=?
                ORDER BY sequence ASC
                LIMIT ? OFFSET ?
                """,
                (job_id, int(limit), int(offset)),
            ).fetchall()
        return [JobLogEntry(**dict(r)) for r in rows]

    def count_job_logs(self, job_id: str) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS cnt FROM job_logs WHERE job_id=?",
                (job_id,),
            ).fetchone()
        return int((row["cnt"] if row else 0) or 0)

    def append_job_log(
        self,
        job_id: str,
        line: str,
        *,
        level: str = "INFO",
        step: str = "",
        source: str = "job_queue",
        created_at: str | None = None,
    ) -> None:
        entry = sanitize_text((line or "").strip())
        if not entry:
            return
        created = created_at or _utc_now_iso()
        time_text = datetime.fromisoformat(created).astimezone(timezone.utc).strftime("%H:%M:%S")
        new_line = f"[{time_text}] {entry}"
        with self._lock:
            row = self._conn.execute(
                "SELECT log_excerpt FROM index_jobs WHERE job_id=?",
                (job_id,),
            ).fetchone()
            if not row:
                return
            old = str((row["log_excerpt"] if row else "") or "")
            merged = (old + "\n" + new_line).strip() if old else new_line
            merged = self._trim_log_excerpt(merged)
            sequence = self._next_job_log_sequence(job_id)
            self._conn.execute(
                """
                INSERT INTO job_logs (job_id, sequence, created_at, level, step, message, source)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (job_id, sequence, created, (level or "INFO").upper(), step, entry, source),
            )
            self._conn.execute(
                "UPDATE index_jobs SET log_excerpt=? WHERE job_id=?",
                (merged, job_id),
            )
            self._conn.commit()

    def cancel_job_if_queued(self, job_id: str) -> bool:
        """若任务仍为 queued，标记为 cancelled。返回是否更新成功（用于与 worker 抢跑）。"""
        finished = _utc_now_iso()
        msg = "Cancelled from queue"
        with self._lock:
            cur = self._conn.execute(
                """
                UPDATE index_jobs
                SET status='cancelled', progress=0, step='cancelled', message=?, finished_at=?
                WHERE job_id=? AND status='queued'
                """,
                (sanitize_text(msg), finished, job_id),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def try_mark_running(self, job_id: str, *, started_at: str) -> bool:
        """仅在仍为 queued 时置为 running，避免取消任务后被 worker 覆盖回 running。"""
        msg = "Started"
        with self._lock:
            cur = self._conn.execute(
                """
                UPDATE index_jobs
                SET status='running', progress=1, step='starting', message=?, started_at=?
                WHERE job_id=? AND status='queued'
                """,
                (sanitize_text(msg), started_at, job_id),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def get_job(self, job_id: str) -> Optional[IndexJob]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM index_jobs WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            return None
        data = dict(row)
        raw_payload_json = str(data.get("payload_json") or "{}")
        try:
            data["payload"] = json.loads(raw_payload_json)
            if not isinstance(data["payload"], dict):
                data["payload"] = {"raw": data["payload"]}
        except Exception:
            data["payload"] = {}
        try:
            data["result"] = json.loads(str(data.get("result_json") or "{}"))
            if not isinstance(data["result"], dict):
                data["result"] = {"raw": data["result"]}
        except Exception:
            data["result"] = {}
        return IndexJob(**data)  # type: ignore[arg-type]

    def count_jobs(
        self,
        *,
        status: Optional[JobStatus] = None,
        project_id: Optional[str] = None,
    ) -> int:
        """与 list_jobs 相同的筛选条件，返回总条数（用于分页）。"""
        where: list[str] = []
        params: list[Any] = []
        if status:
            where.append("status=?")
            params.append(status)
        if project_id:
            where.append("project_id=?")
            params.append(project_id)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        sql = f"SELECT COUNT(*) AS cnt FROM index_jobs {where_sql}"
        with self._lock:
            row = self._conn.execute(sql, tuple(params)).fetchone()
        if not row:
            return 0
        return int(row["cnt"])

    def list_jobs(
        self,
        *,
        status: Optional[JobStatus] = None,
        project_id: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[IndexJob]:
        where: list[str] = []
        params: list[Any] = []
        if status:
            where.append("status=?")
            params.append(status)
        if project_id:
            where.append("project_id=?")
            params.append(project_id)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        sql = f"SELECT * FROM index_jobs {where_sql} ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([int(limit), int(offset)])
        with self._lock:
            rows = self._conn.execute(sql, tuple(params)).fetchall()
        out: list[IndexJob] = []
        for row in rows:
            data = dict(row)
            try:
                data["payload"] = json.loads(str(data.get("payload_json") or "{}"))
                if not isinstance(data["payload"], dict):
                    data["payload"] = {"raw": data["payload"]}
            except Exception:
                data["payload"] = {}
            try:
                data["result"] = json.loads(str(data.get("result_json") or "{}"))
                if not isinstance(data["result"], dict):
                    data["result"] = {"raw": data["result"]}
            except Exception:
                data["result"] = {}
            out.append(IndexJob(**data))  # type: ignore[arg-type]
        return out

    def update_project_name_for_project(self, project_id: str, project_name: str) -> int:
        """将同一 project_id 下所有历史任务的 project_name 批量更新为展示名（可为空）。"""
        pid = str(project_id or "").strip()
        if not pid:
            return 0
        pname = (project_name or "").strip()
        with self._lock:
            cur = self._conn.execute(
                "UPDATE index_jobs SET project_name=? WHERE project_id=?",
                (pname, pid),
            )
            self._conn.commit()
            return int(cur.rowcount or 0)

    def latest_project_name_by_project_id(self) -> dict[str, str]:
        """
        每个 project_id 在「创建时间最新」的那条任务里的 project_name（用于列表展示名回填）。
        """
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT j.project_id, j.project_name
                FROM index_jobs j
                INNER JOIN (
                    SELECT project_id, MAX(created_at) AS mx
                    FROM index_jobs
                    GROUP BY project_id
                ) t ON j.project_id = t.project_id AND j.created_at = t.mx
                """
            ).fetchall()
        out: dict[str, str] = {}
        for r in rows:
            pid = str(r["project_id"] or "")
            if not pid:
                continue
            out[pid] = str(r["project_name"] or "").strip()
        return out

    def latest_repo_url_by_project_id(self) -> dict[str, str]:
        """每个 project_id 最近一条非空 repo_url；若都为空，则回退到最新任务记录。"""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT project_id, repo_url
                FROM (
                    SELECT
                        project_id,
                        repo_url,
                        ROW_NUMBER() OVER (
                            PARTITION BY project_id
                            ORDER BY CASE WHEN TRIM(COALESCE(repo_url, '')) != '' THEN 0 ELSE 1 END,
                                     created_at DESC
                        ) AS rn
                    FROM index_jobs
                ) ranked
                WHERE rn = 1
                """
            ).fetchall()
        out: dict[str, str] = {}
        for r in rows:
            pid = str(r["project_id"] or "")
            if not pid:
                continue
            out[pid] = str(r["repo_url"] or "").strip()
        return out

    def latest_repo_url_for_project(self, project_id: str) -> str:
        pid = str(project_id or "").strip()
        if not pid:
            return ""
        with self._lock:
            row = self._conn.execute(
                """
                SELECT repo_url
                FROM index_jobs
                WHERE project_id=?
                ORDER BY CASE WHEN TRIM(COALESCE(repo_url, '')) != '' THEN 0 ELSE 1 END,
                         created_at DESC
                LIMIT 1
                """,
                (pid,),
            ).fetchone()
        return str((row["repo_url"] if row else "") or "").strip()

    def earliest_job_created_at_by_project_id(self) -> dict[str, str]:
        """每个 project_id 最早一条索引任务的 created_at（ISO 文本），近似「首次入队/创建」时间。"""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT project_id, MIN(created_at) AS first_at
                FROM index_jobs
                GROUP BY project_id
                """
            ).fetchall()
        out: dict[str, str] = {}
        for r in rows:
            pid = str(r["project_id"] or "")
            at = str(r["first_at"] or "").strip()
            if pid and at:
                out[pid] = at
        return out

    def reset_running_jobs_on_startup(self) -> int:
        with self._lock:
            rows = self._conn.execute("SELECT job_id FROM index_jobs WHERE status='running'").fetchall()
            ids = [r["job_id"] for r in rows]
            for job_id in ids:
                self._conn.execute(
                    """
                    UPDATE index_jobs
                    SET status='queued', progress=0, step='queued',
                        message='Re-queued after service restart', started_at='', finished_at=''
                    WHERE job_id=?
                    """,
                    (job_id,),
                )
            self._conn.commit()
        return len(ids)

    def iter_queued_job_ids(self) -> Iterable[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT job_id FROM index_jobs WHERE status='queued' ORDER BY created_at ASC"
            ).fetchall()
        for r in rows:
            yield r["job_id"]


def _apply_index_progress(store: JobStore, job_id: str, payload: dict[str, Any]) -> None:
    """根据 pipeline 进度字典更新任务行（API 进程与子进程共用）。"""
    stage = str(payload.get("stage") or "")
    pct = payload.get("percent")
    level = str(payload.get("level") or "INFO")
    try:
        pct_i = int(pct) if pct is not None else None
    except Exception:
        pct_i = None

    status = str(payload.get("status") or "")
    reason = str(payload.get("reason") or "")
    error = str(payload.get("error") or "")

    lang = effective_content_language()
    done_ok, fail_prefix, fail_generic = index_done_messages(lang)
    stage_msgs = index_progress_messages(lang)

    if status and stage == "done":
        if status == "done":
            msg = done_ok
        elif status == "failed":
            msg = f"{fail_prefix}{error}" if error else fail_generic
        else:
            msg = status
    elif reason:
        msg = reason
    elif error:
        msg = error
    else:
        msg = stage_msgs.get(stage, stage or index_generic_processing(lang))
        if stage == "parse_functions":
            try:
                done = int(payload.get("parsed") or 0)
                tot = int(payload.get("file_count") or 0)
            except (TypeError, ValueError):
                done, tot = 0, 0
            if tot > 0:
                msg = index_parse_progress_msg(lang, done, tot)

    store.update_job(job_id, progress=pct_i, step=stage or "running", message=msg)
    if stage:
        details: list[str] = []
        for key in ("mode", "status", "reason", "error", "file_count", "parsed", "chunk_count", "doc_count", "embedded", "attempted", "head"):
            value = payload.get(key)
            if value not in (None, "", []):
                details.append(f"{key}={value}")
        suffix = f" ({', '.join(details)})" if details else ""
        store.append_job_log(job_id, f"{stage}: {msg}{suffix}", level=level, step=stage, source="pipeline_progress")


def _run_job_subprocess(job_id: str) -> None:
    """
    在独立子进程中执行整条索引管道，与 API 进程 CPU/GIL 完全隔离。
    须为模块级函数以便 multiprocessing spawn 可 pickle。
    """
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        )

    from app.indexer import run_index_pipeline

    store = get_job_store()
    job = store.get_job(job_id)
    if not job:
        logger.error("Index subprocess: job not found job_id=%s", job_id)
        return

    try:
        latest_job = store.get_job(job_id) or job
        payload = latest_job.payload or {}
        if latest_job.job_type == "issue_reply":
            payload = get_issue_reply_job_payload(job_id)
        if latest_job.job_type == "impact_analysis" and not payload:
            store.append_job_log(job_id, "worker: payload is empty after reload", level="ERROR", step="starting", source="job_queue")
            logger.error("job subprocess empty payload job_id=%s job_type=%s project_id=%s", job_id, latest_job.job_type, latest_job.project_id)
        if latest_job.job_type == "issue_reply" and not payload:
            store.append_job_log(job_id, "worker: issue reply payload missing", level="ERROR", step="issue_reply", source="job_queue")
            raise RuntimeError("issue reply payload missing")

        if latest_job.job_type == "index":
            auth_url = build_repo_url_for_clone(latest_job.repo_url)
            run_index_pipeline(
                repo_url=auth_url,
                project_id=latest_job.project_id,
                progress=lambda p: _apply_index_progress(store, job_id, p),
                project_name=latest_job.project_name,
            )
            result_payload: dict[str, Any] = {}
            success_message = "完成"
        elif latest_job.job_type == "impact_analysis":
            from app.automation import analyze_local_commit
            from app.vector_project_index_repo import _upsert_project_index_in_db, get_project_index_meta

            store.update_job(job_id, progress=15, step="impact_analysis", message="Preparing local commit impact analysis")
            result_payload = analyze_local_commit(
                project_id=latest_job.project_id,
                repo_path=str(payload.get("repo_path") or ""),
                repo_url=latest_job.repo_url,
                branch=str(payload.get("branch") or ""),
                commit_sha=str(payload.get("commit_sha") or ""),
                parent_commit_sha=str(payload.get("parent_commit_sha") or ""),
                author=str(payload.get("author") or ""),
                message=str(payload.get("message") or ""),
                trigger_source=str(payload.get("trigger_source") or "git_hook"),
                job_id=job_id,
            )
            meta = get_project_index_meta(latest_job.project_id) or {}
            _upsert_project_index_in_db(
                latest_job.project_id,
                int(meta.get("doc_count") or 0),
                latest_job.project_name,
                last_analyzed_commit=str(result_payload.get("commit_sha") or ""),
                last_impact_job_id=job_id,
                last_local_repo_path=str(payload.get("repo_path") or ""),
            )
            success_message = "Impact analysis completed"
        elif latest_job.job_type == "issue_reply":
            from app.automation import generate_issue_reply

            store.update_job(job_id, progress=15, step="issue_reply", message="Preparing issue auto reply")
            result_payload = generate_issue_reply(payload=payload, job_id=job_id)
            success_message = "Issue auto reply analyzed"
        else:
            raise RuntimeError(f"Unsupported job type: {job.job_type}")
        finished = _utc_now_iso()
        store.update_job(
            job_id,
            status="succeeded",
            progress=100,
            step="done",
            message=success_message,
            finished_at=finished,
            failure_reason="",
            result=result_payload,
        )
        store.append_job_log(job_id, f"done: {success_message}")
    except Exception as e:  # noqa: S110
        finished = _utc_now_iso()
        err = sanitize_text(str(e))
        tb = sanitize_text(traceback.format_exc())
        store.update_job(
            job_id,
            status="failed",
            step="failed",
            message=f"失败: {err}",
            finished_at=finished,
            failure_reason=err,
        )
        if tb:
            store.append_job_log(job_id, tb)
        logger.exception("Index subprocess failed (job_id=%s, project_id=%s): %s", job_id, job.project_id, e)


class IndexJobQueue:
    def __init__(self, store: JobStore):
        self.store = store
        self._q: "Queue[str]" = Queue()
        self._stop = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._current_job_id: str = ""
        self._current_process: Optional[mp.Process] = None
        self._ctl_lock = threading.Lock()
        self._cancel_user_requested: set[str] = set()

    def start(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        reset = self.store.reset_running_jobs_on_startup()
        if reset:
            logger.warning("Reset %s running jobs to queued on startup.", reset)
        for job_id in self.store.iter_queued_job_ids():
            self._q.put(job_id)
        self._worker = threading.Thread(target=self._run_loop, name="index-job-worker", daemon=True)
        self._worker.start()
        logger.info("Index job queue started.")

    def enqueue(
        self,
        project_id: str,
        repo_url: str,
        project_name: str = "",
        *,
        job_type: str = "index",
        payload: dict[str, Any] | str | None = None,
    ) -> IndexJob:
        job = self.store.create_job(
            project_id,
            repo_url,
            project_name=project_name,
            job_type=job_type,
            payload=payload,
        )
        self._q.put(job.job_id)
        return job

    def get_current_job_id(self) -> str:
        return self._current_job_id

    def request_cancel(self, job_id: str) -> str:
        """
        取消排队中或正在执行的索引任务。
        返回: not_found | already_done | cancelled_queued | cancelled_running | cancelled_stale
        """
        store = self.store
        job = store.get_job(job_id)
        if not job:
            return "not_found"
        if job.status in ("succeeded", "failed", "cancelled"):
            return "already_done"

        if job.status == "queued":
            if store.cancel_job_if_queued(job_id):
                return "cancelled_queued"
            job = store.get_job(job_id)
            if not job:
                return "not_found"
            if job.status in ("succeeded", "failed", "cancelled"):
                return "already_done"

        if job.status != "running":
            return "already_done"

        with self._ctl_lock:
            cur = self._current_job_id
            proc = self._current_process
        if cur != job_id:
            job2 = store.get_job(job_id)
            if not job2:
                return "not_found"
            if job2.status in ("succeeded", "failed", "cancelled"):
                return "already_done"
            finished = _utc_now_iso()
            store.update_job(
                job_id,
                status="cancelled",
                progress=int(job2.progress or 0),
                step="cancelled",
                message="任务已取消",
                finished_at=finished,
            )
            return "cancelled_stale"

        with self._ctl_lock:
            self._cancel_user_requested.add(job_id)
            proc = self._current_process
        if proc is not None and proc.is_alive():
            logger.info("User requested cancel: terminating index subprocess job_id=%s", job_id)
            proc.terminate()
        return "cancelled_running"

    def shutdown(self, wait: bool = True) -> None:
        """停止队列线程；若正在跑子进程索引则 terminate。"""
        self._stop.set()
        proc = self._current_process
        if proc is not None and proc.is_alive():
            logger.warning("Terminating index subprocess (pid=%s)", proc.pid)
            proc.terminate()
            if wait:
                proc.join(timeout=120)
        if self._worker and self._worker.is_alive():
            self._worker.join(timeout=5)

    def _start_job_subprocess(self, job_id: str) -> mp.Process:
        """启动索引子进程并登记当前进程句柄。"""
        proc = _mp_spawn.Process(
            target=_run_job_subprocess,
            args=(job_id,),
            name=f"index-job-{job_id[:8]}",
            daemon=False,
        )
        self._current_process = proc
        proc.start()
        return proc

    def _terminate_running_subprocess(self, proc: mp.Process, *, job_id: str) -> None:
        """优雅终止子进程，必要时升级为 kill。"""
        logger.warning("Stop requested, terminating index subprocess job_id=%s", job_id)
        proc.terminate()
        proc.join(timeout=120)
        if proc.is_alive():
            try:
                proc.kill()
            except Exception:
                pass
            proc.join(timeout=15)

    def _join_until_exit_or_stop(self, job_id: str, proc: mp.Process) -> int | None:
        """循环等待子进程退出；收到 stop 信号时中断并终止子进程。"""
        while proc.is_alive():
            proc.join(timeout=0.5)
            if self._stop.is_set():
                self._terminate_running_subprocess(proc, job_id=job_id)
                break
        return proc.exitcode

    def _handle_post_run_state(self, job_id: str, exit_code: int | None) -> None:
        """按 stop/取消/退出码更新任务最终状态。"""
        j = self.store.get_job(job_id)
        if self._stop.is_set():
            if j and j.status == "running":
                self.store.update_job(
                    job_id,
                    status="cancelled",
                    progress=j.progress,
                    step="cancelled",
                    message="服务关闭，任务已终止",
                    finished_at=_utc_now_iso(),
                )
            return

        if job_id in self._cancel_user_requested:
            with self._ctl_lock:
                self._cancel_user_requested.discard(job_id)
            j2 = self.store.get_job(job_id)
            if j2 and j2.status in ("succeeded", "cancelled"):
                return
            prog = int(j2.progress) if j2 and j2.progress is not None else 0
            self.store.update_job(
                job_id,
                status="cancelled",
                progress=max(0, min(100, prog)),
                step="cancelled",
                message="用户已取消",
                finished_at=_utc_now_iso(),
            )
            return

        if exit_code not in (0, None) and j and j.status == "running":
            self.store.update_job(
                job_id,
                status="failed",
                step="failed",
                message=f"子进程异常退出 (code={exit_code})",
                finished_at=_utc_now_iso(),
                failure_reason=f"子进程异常退出 code={exit_code}",
            )
            self.store.append_job_log(job_id, f"worker: subprocess exited abnormally with code={exit_code}")
            logger.error("Index subprocess exited abnormally job_id=%s exitcode=%s", job_id, exit_code)

    def _handle_subprocess_failure(self, job_id: str, exc: Exception) -> None:
        """处理 worker 级异常并写回失败状态与日志。"""
        finished = _utc_now_iso()
        err = sanitize_text(str(exc))
        tb = sanitize_text(traceback.format_exc())
        self.store.update_job(
            job_id,
            status="failed",
            step="failed",
            message=f"失败: {err}",
            finished_at=finished,
            failure_reason=err,
        )
        if tb:
            self.store.append_job_log(job_id, tb)
        logger.exception("Failed to start or run index subprocess (job_id=%s): %s", job_id, exc)

    def _run_loop(self) -> None:
        while not self._stop.is_set():
            try:
                job_id = self._q.get(timeout=0.5)
            except Empty:
                continue

            job = self.store.get_job(job_id)
            if not job or job.status != "queued":
                self._q.task_done()
                continue

            started = _utc_now_iso()
            if not self.store.try_mark_running(job_id, started_at=started):
                self._q.task_done()
                continue

            self._current_job_id = job_id

            try:
                proc = self._start_job_subprocess(job_id)
                ec = self._join_until_exit_or_stop(job_id, proc)
                self._handle_post_run_state(job_id, ec)
            except Exception as e:
                self._handle_subprocess_failure(job_id, e)
            finally:
                self._current_process = None
                self._current_job_id = ""
                self._q.task_done()
                time.sleep(0.05)


_store: JobStore | None = None
_queue: IndexJobQueue | None = None


def get_job_store() -> JobStore:
    global _store
    if _store is None:
        db_path = settings.data_path / "index_jobs.sqlite3"
        _store = JobStore(db_path)
    return _store


def get_job_queue() -> IndexJobQueue:
    global _queue
    if _queue is None:
        _queue = IndexJobQueue(get_job_store())
    return _queue
