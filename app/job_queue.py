from __future__ import annotations

import logging
import re
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from queue import Empty, Queue
from typing import Any, Iterable, Literal, Optional
from urllib.parse import quote, urlparse, urlunparse

from app.config import settings

logger = logging.getLogger(__name__)

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


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
    - settings.gitlab_access_token 有值
    - URL 本身不包含 userinfo
    """
    token = (settings.gitlab_access_token or "").strip()
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
    # token 可能包含特殊字符（如 @、:、/），必须 URL 编码，否则会被解析截断导致鉴权失败
    token_enc = quote(token, safe="")
    netloc = f"oauth2:{token_enc}@{netloc}"

    # GitLab HTTPS clone 通常兼容不带 .git，但某些环境会因重定向/策略导致鉴权异常；这里做一次保守补齐
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


class JobStore:
    """SQLite 持久化任务状态（单进程/单容器）。"""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
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
                    finished_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_index_jobs_status ON index_jobs(status)")
            self._conn.execute("CREATE INDEX IF NOT EXISTS idx_index_jobs_project ON index_jobs(project_id)")
            cols = {row[1] for row in self._conn.execute("PRAGMA table_info(index_jobs)")}
            if "project_name" not in cols:
                self._conn.execute(
                    "ALTER TABLE index_jobs ADD COLUMN project_name TEXT NOT NULL DEFAULT ''"
                )
            self._conn.commit()

    def create_job(self, project_id: str, repo_url: str, project_name: str = "") -> IndexJob:
        job_id = str(uuid.uuid4())
        now = _utc_now_iso()
        clean_url = normalize_repo_url(repo_url)
        pname = (project_name or "").strip()
        job = IndexJob(
            job_id=job_id,
            project_id=project_id,
            repo_url=clean_url,
            project_name=pname,
            status="queued",
            progress=0,
            step="queued",
            message="已进入队列",
            created_at=now,
            started_at="",
            finished_at="",
        )
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO index_jobs
                (job_id, project_id, repo_url, project_name, status, progress, step, message, created_at, started_at, finished_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                ),
            )
            self._conn.commit()
        return job

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
        if not fields:
            return
        values.append(job_id)
        sql = f"UPDATE index_jobs SET {', '.join(fields)} WHERE job_id=?"
        with self._lock:
            self._conn.execute(sql, tuple(values))
            self._conn.commit()

    def get_job(self, job_id: str) -> Optional[IndexJob]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM index_jobs WHERE job_id=?", (job_id,)).fetchone()
        if not row:
            return None
        return IndexJob(**dict(row))  # type: ignore[arg-type]

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
        return [IndexJob(**dict(r)) for r in rows]  # type: ignore[misc]

    def reset_running_jobs_on_startup(self) -> int:
        with self._lock:
            rows = self._conn.execute("SELECT job_id FROM index_jobs WHERE status='running'").fetchall()
            ids = [r["job_id"] for r in rows]
            for job_id in ids:
                self._conn.execute(
                    """
                    UPDATE index_jobs
                    SET status='queued', progress=0, step='queued',
                        message='服务重启后重新入队', started_at='', finished_at=''
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


class IndexJobQueue:
    def __init__(self, store: JobStore):
        self.store = store
        self._q: "Queue[str]" = Queue()
        self._stop = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._current_job_id: str = ""

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

    def enqueue(self, project_id: str, repo_url: str, project_name: str = "") -> IndexJob:
        job = self.store.create_job(project_id, repo_url, project_name=project_name)
        self._q.put(job.job_id)
        return job

    def get_current_job_id(self) -> str:
        return self._current_job_id

    def _run_loop(self) -> None:
        from app.indexer import run_index_pipeline

        while not self._stop.is_set():
            try:
                job_id = self._q.get(timeout=0.5)
            except Empty:
                continue

            job = self.store.get_job(job_id)
            if not job or job.status != "queued":
                self._q.task_done()
                continue

            self._current_job_id = job_id
            started = _utc_now_iso()
            self.store.update_job(
                job_id,
                status="running",
                progress=1,
                step="starting",
                message="开始执行",
                started_at=started,
            )

            def reporter(payload: dict[str, Any]) -> None:
                stage = str(payload.get("stage") or "")
                pct = payload.get("percent")
                try:
                    pct_i = int(pct) if pct is not None else None
                except Exception:
                    pct_i = None

                status = str(payload.get("status") or "")
                reason = str(payload.get("reason") or "")
                error = str(payload.get("error") or "")

                if status and stage == "done":
                    if status == "done":
                        msg = "完成"
                    elif status == "failed":
                        msg = f"失败: {error}" if error else "失败"
                    else:
                        msg = status
                elif reason:
                    msg = reason
                elif error:
                    msg = error
                else:
                    msg = {
                        "clone_or_pull": "克隆/拉取仓库中",
                        "collect_files": "扫描代码文件中",
                        "parse_functions": "函数级解析中",
                        "describe_chunks": "生成函数中文描述中（如已配置 LLM）",
                        "generate_wiki": "生成静态 Wiki（MkDocs）中",
                        "upsert_vector_store": "向量化并写入向量库中",
                        "done": "收尾中",
                    }.get(stage, stage or "处理中")

                self.store.update_job(job_id, progress=pct_i, step=stage or "running", message=msg)

            try:
                # job.repo_url 是干净 URL；执行时再注入 token
                auth_url = build_repo_url_for_clone(job.repo_url)
                run_index_pipeline(
                    repo_url=auth_url,
                    project_id=job.project_id,
                    progress=reporter,
                    project_name=job.project_name,
                )
                finished = _utc_now_iso()
                self.store.update_job(job_id, status="succeeded", progress=100, step="done", message="完成", finished_at=finished)
            except Exception as e:  # noqa: S110
                finished = _utc_now_iso()
                self.store.update_job(job_id, status="failed", step="failed", message=f"失败: {e}", finished_at=finished)
                logger.exception("Index job failed (job_id=%s, project_id=%s): %s", job_id, job.project_id, e)
            finally:
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
