import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import JSONResponse

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
    # 向量库与 embedding 模型改为首次使用时再加载，便于本地先起服务调试
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
    }
