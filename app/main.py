import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import settings
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


app = FastAPI(
    title="GitLab 代码分析服务",
    description="GitLab Push → 自动索引 → 生成功能说明 → 向量库 → Dify 查询",
    lifespan=lifespan,
)

app.include_router(webhook_router, prefix="/webhook", tags=["webhook"])
# 查询接口供 Dify 或前端调用
from app.query import router as query_router
app.include_router(query_router, prefix="/api", tags=["query"])
from app.jobs_api import router as jobs_router
app.include_router(jobs_router, prefix="/api", tags=["jobs"])

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
        "webhook": "POST /webhook/gitlab",
        "query": "POST /api/query",
        "wiki": "GET /wiki/<project_id>/site/ （索引成功后静态站）",
        "wiki_meta": "GET /api/wiki/{project_id}",
    }
