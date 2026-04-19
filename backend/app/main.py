from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api_errors import install_error_handlers
from app.config import settings
from app.observability import install_observability
from app.webhook import router as webhook_router

# 基础日志配置：INFO 级别以上都会输出，带时间和模块名，方便观察运行过程
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
# ChromaDB 遥测在无 API key 时会打 ERROR，不影响功能，仅屏蔽该日志避免误导
logging.getLogger("chromadb.telemetry.product.posthog").setLevel(logging.CRITICAL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动任务队列 worker（串行执行索引任务，避免并发写库导致失败）
    try:
        from app.job_queue import get_job_queue

        get_job_queue().start()
    except Exception as e:
        logging.getLogger(__name__).warning("Failed to start job queue: %s", e)
    yield
    try:
        from app.job_queue import get_job_queue

        get_job_queue().shutdown()
    except Exception as e:
        logging.getLogger(__name__).warning("Job queue shutdown: %s", e)


app = FastAPI(
    title="Git 代码索引服务",
    description="Git 托管 Webhook 或手动触发 → 索引 → 向量库 → 检索 / 对话",
    lifespan=lifespan,
)
install_observability(app)
install_error_handlers(app)

_cors = [o.strip() for o in (settings.cors_origins or "").split(",") if o.strip()]
if _cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(webhook_router, prefix="/webhook", tags=["webhook"])
# 查询接口供 Dify 或前端调用
from app.auth_ui import router as auth_ui_router

app.include_router(auth_ui_router, prefix="/api", tags=["auth-ui"])
from app.query import router as query_router

app.include_router(query_router, prefix="/api", tags=["query"])
from app.jobs_api import router as jobs_router

app.include_router(jobs_router, prefix="/api", tags=["jobs"])
from app.settings_api import router as settings_router

app.include_router(settings_router, prefix="/api", tags=["settings"])
from app.audit_api import router as audit_router

app.include_router(audit_router, prefix="/api", tags=["audit"])
from app.storage_api import router as storage_router

app.include_router(storage_router, prefix="/api", tags=["storage"])
from app.llm_usage_api import router as llm_usage_router

app.include_router(llm_usage_router, prefix="/api", tags=["llm-usage"])
from app.code_chat_api import router as code_chat_router

app.include_router(code_chat_router, prefix="/api", tags=["code-chat"])
from app.project_detail_api import router as project_detail_router

app.include_router(project_detail_router, prefix="/api", tags=["project-detail"])


def _admin_dist() -> Path | None:
    """
    镜像内：/app/frontend/dist（与 app 包同级）。
    本地：在 backend/ 下运行时，前端构建产物在仓库根目录的 frontend/dist。
    """
    pkg_root = Path(__file__).resolve().parent.parent
    for base in (pkg_root, pkg_root.parent):
        p = base / "frontend" / "dist"
        if p.is_dir() and (p / "index.html").is_file():
            return p
    return None


@app.get("/admin")
@app.get("/admin/")
async def admin_spa_index():
    dist = _admin_dist()
    if not dist:
        raise HTTPException(status_code=404, detail="Admin UI not built (run: cd frontend && npm run build)")
    return FileResponse(dist / "index.html")


@app.get("/admin/{rest:path}")
async def admin_spa_or_asset(rest: str):
    dist = _admin_dist()
    if not dist:
        raise HTTPException(status_code=404, detail="Admin UI not built (run: cd frontend && npm run build)")
    candidate = (dist / rest).resolve()
    try:
        candidate.relative_to(dist.resolve())
    except ValueError:
        raise HTTPException(status_code=404, detail="Invalid path")
    if candidate.is_file():
        return FileResponse(candidate)
    return FileResponse(dist / "index.html")

_wiki_root = settings.data_path / "wiki_sites"
_wiki_root.mkdir(parents=True, exist_ok=True)
app.mount(
    "/wiki",
    StaticFiles(directory=str(_wiki_root), html=True),
    name="wiki",
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/")
def root():
    return {
        "service": "gitlab-vetor",
        "docs": "/docs",
        "admin": "/admin/",
        "webhooks": [
            "POST /webhook/gitlab",
            "POST /webhook/github",
            "POST /webhook/gitea",
        ],
        "webhook_trigger": "POST /webhook/trigger",
        "local_commit": "POST /webhook/local-commit",
        "issue_event": "POST /webhook/issue-event",
        "query": "POST /api/query",
        "code_chat": "POST /api/code-chat",
        "code_chat_stream": "POST /api/code-chat/stream",
        "wiki": "GET /wiki/<project_id>/site/",
        "wiki_meta": "GET /api/wiki/{project_id}",
    }
