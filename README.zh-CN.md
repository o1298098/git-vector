# GitLab 代码分析 → 向量库（Chroma）→ 语义检索（供 Dify/前端调用）

**Languages**: [English](README.md) | **中文**

本服务用于把 GitLab 仓库代码“索引成可检索的向量知识库”：当 GitLab Push（或手动触发）时自动拉取代码，按**函数级**（解析不到则自动退化为**文件级**）切分 chunk，可选用 LLM 为 chunk 生成一行中文描述，然后做 embedding 写入 Chroma。随后可通过 HTTP API 做语义检索，把结果喂给 Dify（API 工具）或任何前端/脚本。

---

## 你会得到什么

- **自动索引**：GitLab `main/master` push 后排队执行索引（避免并发写库/写 repo 目录导致失败）
- **可查进度**：索引任务入队后返回 `job_id`，可查询状态与进度
- **可语义检索**：返回包含 `path`、`name`、`start_line`、`end_line` 等元数据，便于跳转定位实现

---

## 工作流（与代码一致）

```text
GitLab Push(main/master) / 手动触发
  ↓
任务入队（SQLite 持久化，worker 串行执行）
  ↓
clone_or_pull：克隆/拉取仓库（可选注入 GITLAB_ACCESS_TOKEN）
  ↓
collect_files：扫描常见代码/配置文件（跳过 node_modules/.git/.env 等）
  ↓
parse_functions：Tree-sitter 函数级解析（0 条则 file-level fallback）
  ↓
describe_chunks（可选）：Dify / Azure OpenAI / OpenAI 生成一行描述
  ↓
upsert_vector_store：Ollama embeddings → Chroma 写入
  ↓
query/search：语义检索（供 Dify/前端调用）
```

---

## 快速开始（Docker）

### 1) 配置 `.env`

```bash
cp .env.example .env
```

常见最小配置：

- **私有 GitLab**：填 `GITLAB_ACCESS_TOKEN`（需 `read_repository`）
- **向量化**：确保 `OLLAMA_BASE_URL` 可访问，且 Ollama 已拉好 `EMBED_MODEL`
- **可选 LLM 描述**：按优先级三选一配置（见下文「LLM 优先级」）

### 2) 启动

```bash
docker compose up -d
```

- **服务地址**：`http://localhost:8000`
- **接口文档**：`http://localhost:8000/docs`
- **代码改动后重建**：`docker compose build --no-cache && docker compose up -d`

---

## 接入 GitLab Webhook

在 GitLab 项目 **Settings → Webhooks** 添加：

- **URL**：`http://<你的服务地址>:8000/webhook/gitlab`
- **Secret token（可选）**：与 `.env` 的 `GITLAB_WEBHOOK_SECRET` 一致
- **Trigger**：勾选 **Push events**

说明：

- **只处理** `object_kind=push` 且分支为 `main/master` 的事件
- 成功入队会返回 `job_id`：`{"status":"queued","project_id":"...","job_id":"..."}`

---

## 不配 Webhook：手动触发索引

### 方式 A：`/webhook/trigger`

```bash
curl -X POST "http://localhost:8000/webhook/trigger" \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://gitlab.com/group/my-repo.git","project_id":"my-repo"}'
```

### 方式 B：`/api/index-jobs/enqueue`（等价入队接口）

```bash
curl -X POST "http://localhost:8000/api/index-jobs/enqueue" \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://gitlab.com/group/my-repo.git","project_id":"my-repo"}'
```

---

## 查询（供 Dify 或前端调用）

### 语义检索

- **POST** `/api/query`

```bash
curl -X POST "http://localhost:8000/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query":"用户登录是怎么实现的？","project_id":"my-repo","top_k":10}'
```

- **GET** `/api/search`

```bash
curl "http://localhost:8000/api/search?q=登录&project_id=my-repo&top_k=10"
```

返回结构：

```json
{
  "results": [
    {
      "score": 0.123,
      "content": "...",
      "metadata": {
        "path": "app/auth.py",
        "name": "login",
        "kind": "function",
        "start_line": 10,
        "end_line": 88
      }
    }
  ]
}
```

### 项目列表 / 索引状态

- **GET** `/api/projects`：列出向量库中已索引的项目及文档数
- **GET** `/api/project/index-status?project_id=xxx`：查看某项目是否已写入向量（`indexed/doc_count`）

---

## 索引队列与进度查询

本服务默认使用**队列串行执行**索引任务（避免并发写 Chroma / 本地 repos 导致失败），任务状态持久化到 SQLite，服务重启后仍可查询历史记录。

- **查看任务列表**：`GET /api/index-jobs?limit=50&offset=0`（可选 `status` / `project_id` 过滤）
- **查看单个任务**：`GET /api/index-jobs/{job_id}`

关键字段：

- **status**：`queued` / `running` / `succeeded` / `failed` / `cancelled`
- **progress**：0-100
- **step**：阶段名（如 `clone_or_pull` / `parse_functions` / `upsert_vector_store`）
- **message**：更友好的中文阶段说明

---

## 环境变量

| 变量 | 说明 |
|------|------|
| `GITLAB_WEBHOOK_SECRET` | GitLab Webhook Secret token（不配则不校验） |
| `GITLAB_ACCESS_TOKEN` | 私有仓库访问 Token（建议至少 `read_repository`）。服务会在 clone/pull 时对 http(s) URL 注入 `oauth2:<token>@...`；对外返回与落库会做“干净 URL”（去除凭据） |
| `DIFY_API_KEY` | Dify 应用 API Key（用于为 chunk 生成一行描述） |
| `DIFY_BASE_URL` | Dify API 地址，默认 `https://api.dify.ai/v1` |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI Key |
| `AZURE_OPENAI_ENDPOINT` | Azure Endpoint（如 `https://xxx.cognitiveservices.azure.com`） |
| `AZURE_OPENAI_VERSION` | Azure API version |
| `AZURE_OPENAI_DEPLOYMENT` | Azure 部署名 |
| `OPENAI_API_KEY` | OpenAI（或兼容接口）Key |
| `OPENAI_BASE_URL` | 兼容接口地址（默认 `https://api.openai.com/v1`） |
| `OPENAI_MODEL` | 模型名/部署名 |
| `DATA_DIR` | 数据目录（默认 `./data`；容器内常用 `/data`） |
| `OLLAMA_BASE_URL` | Ollama 地址（默认 `http://host.docker.internal:11434`，便于容器访问宿主机 Ollama；按实际环境调整） |
| `EMBED_MODEL` | Ollama embedding 模型名（如 `nomic-embed-text`、`mxbai-embed-large`）。**更换模型后需清空 `DATA_DIR/chroma` 并重新索引**（向量维度会变） |
| `SKIP_VECTOR_STORE` | 设为 `1` 时只跑 clone/解析/（可选 LLM），不写入 Chroma（用于本地验证流程） |

### LLM 优先级（只会选一个）

用于“为函数/文件生成一行描述”的 LLM 按以下优先级自动选择：

1. **Dify**：配置 `DIFY_API_KEY`（可选 `DIFY_BASE_URL`）
2. **Azure OpenAI**：配置 `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`
3. **OpenAI 兼容**：配置 `OPENAI_API_KEY`

不配置任何 LLM 时仍可索引与检索，只是 `content` 里不会附加自然语言描述（仍包含路径/名称/代码片段）。

---

## 数据与持久化

默认在 `DATA_DIR` 下：

- **仓库镜像**：`DATA_DIR/repos/<project_id>/...`
- **向量库**：`DATA_DIR/chroma/`
- **索引任务 DB**：`DATA_DIR/index_jobs.sqlite3`

---

## 开发（本地调试）

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

补充说明：

- 服务启动时会尝试启动索引队列 worker；向量库/embedding 相关对象通常在首次索引或首次查询时才会加载。
- 看到日志 `No function-level chunks parsed ...; using file-level fallback` 表示函数级解析得到 0 条，已自动退化为文件级 chunk（检索仍可用，只是粒度变粗）。

