# Git 代码索引 → 向量库（Chroma）→ 语义搜索（Dify / 管理后台）

**语言**：[English](README.md) | **中文**

这个服务可以把 **Git 仓库**（GitLab、GitHub、Gitea 等常见平台，或任意可 clone 的仓库 URL）索引到可搜索的向量知识库中。它会在 `main` / `master` 分支收到 push webhook 时，或在你手动调用触发 API 时，拉取代码、按 **函数级别** 切块（如果解析后没有函数，则回退到 **文件级别**）、可选地为每个 chunk 生成一行 LLM 描述，然后执行向量化并写入 Chroma。你可以通过 HTTP API 查询、使用自带管理后台、把检索结果接入 Dify（API Tool），或直接调用 **代码问答** 接口。

## 截图

管理后台（`/admin/`）：包含已索引项目总览、快捷入口，以及基于向量索引的自然语言 **语义搜索**。

| 总览 | 语义搜索 |
|------|----------|
| ![管理后台总览——已索引项目与快捷入口](docs/images/overview.png) | ![语义搜索——查询与排序后的代码片段](docs/images/semantic-search.png) |

---

## 你将获得什么

- **自动索引**：支持 **GitLab**、**GitHub**、**Gitea** 的 `main` / `master` push webhook（串行 worker 避免并发写入失败）；其他平台可通过 **手动触发** 或 CI 调用同一个入队 API
- **提交影响分析**：push webhook 还可以额外入队项目级影响分析任务，评估变更文件、变更模块、受影响区域、跨系统影响、风险、验证重点以及建议评审人
- **Issue 自动化**：支持 GitLab、GitHub、Gitea/Gitee 的 issue 事件写入项目 issue 流，结合检索到的代码上下文进行分析，并可选择通过平台 API 自动回复
- **项目详情工作区**：管理后台包含仓库摘要、Issue 管理、类似聊天的 issue 详情历史、影响分析历史以及仓库级自动化配置
- **进度追踪**：入队后会返回 `job_id`，你可以随时查询任务状态和进度
- **语义搜索**：结果包含 `path`、`name`、`start_line`、`end_line` 等字段，便于快速定位
- **代码问答**（可选 LLM）：提供 `POST /api/code-chat` 及其流式版本（详见 `/docs` 的 OpenAPI）

---

## 30 秒快速开始

```bash
cp .env.example .env
docker compose up -d
curl "http://localhost:8000/health"
```

然后打开：

- `http://localhost:8000/docs` 查看 OpenAPI
- `http://localhost:8000/admin/` 打开管理后台

第一次进行有效索引前，至少需要配置：

- **Embedding**（见[环境变量](#环境变量)）：默认 **`EMBED_PROVIDER=ollama`** 需要 **`OLLAMA_BASE_URL`** 和 **`EMBED_MODEL`**；如果使用 **`EMBED_PROVIDER=openai`**，则需要 **`OPENAI_EMBED_BASE_URL`**、**`OPENAI_EMBED_API_KEY`** 和 OpenAI 的 **`EMBED_MODEL`**（例如 `text-embedding-3-small`）。Embedding 的 OpenAI 配置与聊天用的 `OPENAI_*` 配置**不是同一组**。
- **私有 HTTPS 仓库**（可选）：`GIT_HTTPS_TOKEN` 或 `GITLAB_ACCESS_TOKEN`
- **Webhook 签名校验**（建议在非局域网环境启用）：为各个平台设置对应 secret

---

## 仓库结构

| 路径 | 作用 |
|------|------|
| `backend/app/` | Python / FastAPI 服务、索引逻辑、Wiki、向量库 |
| `backend/requirements.txt` | 后端依赖 |
| `frontend/` | React + Vite 管理后台（构建产物挂载在 `/admin/`） |
| `docs/images/` | README 截图 |
| `LICENSE` | MIT 许可证 |
| `scripts/` | 辅助脚本 |

---

## 工作流程（与代码实现一致）

```text
Webhook push（GitLab / GitHub / Gitea，main/master）/ 手动触发（任意 Git URL）
  ↓
任务入队（SQLite 持久化，单串行 worker）
  ↓
clone_or_pull：克隆/拉取仓库（可选 HTTPS 鉴权：GIT_HTTPS_TOKEN 或 GITLAB_ACCESS_TOKEN，见下文）
  ↓
collect_files：扫描常见代码/配置文件（跳过 `node_modules` / `.git` / `.env` 等）
  ↓
parse_functions：Tree-sitter 函数级解析（0 个结果时回退到文件级）
  ↓
describe_chunks（可选）：通过 `LLM_PROVIDER` 生成单行描述（Dify / Azure OpenAI / OpenAI-compatible）
  ↓
generate_wiki：在 DATA_DIR/wiki_sites 下生成静态 Wiki（MkDocs / Starlight / VitePress）
  ↓
upsert_vector_store：向量化（`EMBED_PROVIDER`：Ollama 或 OpenAI-compatible）→ 写入 Chroma
  ↓
query/search：语义检索（供 Dify / 前端使用）

额外的 webhook 自动化流程
  ↓
Push webhook → 入队 `impact_analysis` → 项目级提交影响分析 → 持久化影响分析历史
  ↓
Issue / comment webhook → 存储项目 issue 流 → 检索相关代码上下文 → 判断是否自动回复 → 可选回帖到 Git 平台
```

---

## 快速开始（Docker）

### 1）配置 `.env`

```bash
cp .env.example .env
```

典型最小配置：

- **私有 HTTPS 仓库**：设置 `GITLAB_ACCESS_TOKEN` 和/或 `GIT_HTTPS_TOKEN`（见[私有 HTTPS 克隆](#私有-https-克隆)）；若使用 **GitHub PAT**，请设置 `GIT_HTTPS_USERNAME=x-access-token`
- **Embedding**：设置 **`EMBED_PROVIDER`**（`ollama` 或 `openai`）以及对应变量（见[环境变量](#环境变量)）；**一旦更换 provider 或 embedding 维度，需要清空 `DATA_DIR/chroma` 并重新索引**
- **可选 LLM 描述 / 代码问答**：将 **`LLM_PROVIDER`** 设置为 `dify`、`azure_openai` 或 `openai`（默认 `openai`），并只配置该 provider 需要的密钥（见[LLM Provider](#llm-provider)）

### 2）启动

```bash
docker compose up -d
```

- **服务地址**：`http://localhost:8000`
- **接口文档**：`http://localhost:8000/docs`
- **代码改动后重建**：`docker compose build --no-cache && docker compose up -d`

---

## Webhook（索引、影响分析、Issue 自动化）

Push webhook 仅会在 **`main` 或 `master`** 分支上入队索引 / 影响分析任务。成功入队时，JSON 响应中会返回 `job_id`。

如果对应的 **secret 环境变量未设置**，则会**跳过**签名校验（适合局域网测试；**不建议**暴露在公网）。

当前 webhook 可以完成：

- **Push 事件**：入队仓库索引和项目级提交影响分析
- **Issue 事件**：把 issue 元数据和消息历史写入项目详情页使用的存储
- **Issue / 评论事件**：结合检索到的代码上下文分析最新用户消息，并可选择通过平台 API 自动回复

### GitLab

在项目 **Settings → Webhooks** 中配置：

- **URL**：`http://<host>:8000/webhook/gitlab`
- **Secret**：与 `GITLAB_WEBHOOK_SECRET` 保持一致（按你的 GitLab 配置发送/校验）
- **Events**：启用 **Push events** 和 **Issue events**；如果你的 GitLab 版本把 issue 变更作为 work item 事件发出，也请启用对应事件
- Push 事件可触发索引和提交影响分析
- Issue / note 事件可更新项目 issue 流，并触发自动回复分析

### GitHub

在仓库 **Settings → Webhooks → Add webhook** 中配置：

- **Payload URL**：`http://<host>:8000/webhook/github`
- **Content type**：`application/json`
- **Secret**：与 `GITHUB_WEBHOOK_SECRET` 保持一致（HMAC SHA-256，Header 为 `X-Hub-Signature-256`）
- **Events**：启用 **Push**、**Issues**、**Issue comment**（ping 事件会以 `200` 忽略处理）
- Push 事件可触发索引和提交影响分析
- 新建 issue 与后续评论可触发 issue 分析和可选自动回复

### Gitea / Gitee

在仓库 **Settings → Webhooks** 中配置：

- **URL**：`http://<host>:8000/webhook/gitea`
- **Secret**：与 `GITEA_WEBHOOK_SECRET` 保持一致（Header 为 `X-Gitea-Signature`，值为原始请求体的 HMAC-SHA256 十六进制）
- **Events**：启用 **Push** 以及你的平台支持的 issue 相关事件
- Push 事件可触发索引和提交影响分析
- Issue / 评论事件可更新 issue 流，并触发可选自动回复

---

## 私有 HTTPS 克隆

对于 HTTPS 私有仓库，当干净 URL 中未显式包含 userinfo 时，worker 会自动把凭据注入 clone URL：

| 变量 | 作用 |
|------|------|
| `GIT_HTTPS_TOKEN` | 如果已设置，**优先级高于** `GITLAB_ACCESS_TOKEN` |
| `GITLAB_ACCESS_TOKEN` | 仍然支持（例如 GitLab 的 `read_repository` PAT） |
| `GIT_HTTPS_USERNAME` | Token 对应的 HTTP Basic 用户名；为空时默认 **`oauth2`**（GitLab）。对于 **GitHub**，请设为 **`x-access-token`** |

你也可以在管理后台 **Settings**（`/admin/`）中设置 **`GIT_HTTPS_USERNAME`**。

---

## 手动索引（不依赖 Webhook）

### 方式 A：`/webhook/trigger`

```bash
curl -X POST "http://localhost:8000/webhook/trigger" \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://github.com/acme/backend.git","project_id":"acme/backend","project_name":"显示名称"}'
```

可使用任意运行环境能够 `git clone` 的 **HTTPS 或 SSH** URL。可选参数 **`project_name`**：用于展示的人类可读名称（例如中文名）。它会被保存到 job 中，并显示在 Wiki 首页、站点标题以及 `manifest.json` 中。

### 方式 B：`/api/index-jobs/enqueue`（等价入队 API）

```bash
curl -X POST "http://localhost:8000/api/index-jobs/enqueue" \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://github.com/acme/backend.git","project_id":"acme/backend","project_name":"显示名称"}'
```

---

## 提交影响分析

提交影响分析可由 push webhook 或内部任务重试触发。分析器会基于服务端保存的项目镜像工作区，召回向量上下文，并输出项目级评估，而不只是描述被修改的文件。

典型输出包括：

- `changed_files`
- `changed_modules`
- `affected_areas`
- `cross_system_impact`
- `risk_level`（`high` / `medium` / `low`）
- `verification_focus`
- 由 LLM 生成的 `summary`、`impact_scope`、`risks`、`tests`、`reviewers`

项目详情页通过 **Impact** 标签页展示这些内容，包括运行历史、紧凑摘要、可搜索的变更文件列表，以及可展开的风险 / 验证区域。

---

## Issue 自动化

Issue 自动化具备 provider 感知能力，目前支持 GitLab、GitHub 与 Gitea/Gitee 风格的 webhook。

它可以：

- 按项目维度存储 issue 元数据和消息历史
- 在管理后台中保留类似聊天记录的 issue 时间线
- 应用项目级自动回复规则、回复模板和人工审核关键词
- 在生成回复前，从向量索引中检索相关代码上下文
- 在策略允许时，自动把回复回帖到 Git 平台
- 避免明显的自触发循环，并在 issue 关闭时同步状态

项目详情页通过 **Issue** 标签页提供这些能力，包括 issue 列表、issue 详情会话、规则编辑和 issue 任务历史。

---

## 查询（供 Dify / 前端使用）

### 语义搜索

- **POST** `/api/query`

```bash
curl -X POST "http://localhost:8000/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query":"用户登录是如何实现的？","project_id":"my-repo","top_k":10}'
```

- **GET** `/api/search`

```bash
curl "http://localhost:8000/api/search?q=login&project_id=my-repo&top_k=10"
```

响应结构：

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

### 项目 / 索引状态

- **GET** `/api/projects`：列出已索引项目及文档数量；每项都包含 `project_name`（显示名称，可为 `null`）；可选 `q`（匹配 `project_id` 或 `project_name` 子串）、`limit` / `offset` 分页参数（不传 `limit` 则返回全量列表，向后兼容）
- **DELETE** `/api/projects/{project_id}`：删除项目向量和元数据
- **POST** `/api/projects/{project_id}/reindex`：为项目入队一次重建
- **GET** `/api/projects/{project_id}/vectors`：分页查看已存储向量
- **GET** `/api/project/index-status?project_id=xxx`：检查项目是否已索引（`indexed` / `doc_count`）

### 管理后台 / 鉴权 / 运维 API

- **鉴权 UI**：`GET /api/auth/status`、`POST /api/auth/login`、`GET /api/auth/me`
- **管理设置**：`GET /api/admin/settings`
- **存储洞察**：`GET /api/admin/storage`
- **LLM 用量指标**：`GET /api/admin/llm-usage`
- **代码问答反馈**：`POST /api/code-chat/feedback`
- **项目摘要**：`GET /api/projects/{project_id}/summary`
- **项目仓库配置**：`PUT /api/projects/{project_id}/repo-config`
- **项目 Issue 规则**：`GET/PUT /api/projects/{project_id}/issue-rules`
- **项目 Issue 列表/详情**：`GET /api/projects/{project_id}/issues`、`GET /api/projects/{project_id}/issues/{provider}/{issue_number}`
- **项目影响分析历史**：`GET /api/projects/{project_id}/impact-runs`
- **项目 Issue 任务**：`GET /api/projects/{project_id}/issue-jobs`

### 静态 Wiki（MkDocs / Starlight / VitePress）

在 `describe_chunks` 之后，worker 会先执行 wiki 构建，再执行向量入库。Wiki 构建失败只会记录日志，不会阻塞索引流程。默认 **`WIKI_BACKEND=mkdocs`**（Material 主题，仅 Python 依赖）。**`starlight`** 或 **`vitepress`** 需要 **Node.js + npm**（本仓库 Dockerfile 已包含；裸机运行需自行安装）。首次构建会在 `wiki_work/<project_id>` 下运行 `npm install`（因此需要 npm registry 访问能力）。输出目录为 `DATA_DIR/wiki_sites/<project_id>/site/`，由 API 直接提供静态访问。

- **浏览地址**：`http://<host>:8000/wiki/<project_id>/site/`（`project_id` 规则与 `repos/` 下保持一致）
- **元数据**：`GET /api/wiki/{project_id}` → 返回最近一次的 `manifest.json`（包含 `wiki_backend`、commit、时间戳、计数等）

页面内容包括概览、架构说明（配置了 LLM 时）、文件索引（树形）、单文件符号页，以及符号总表（较大时会自动拆分）。MkDocs 使用 Lunr 搜索；Starlight/VitePress 使用内置本地搜索。对每个符号，**Functionality** 区块只展示索引流程中 **LLM 生成的** 单行描述（与向量库中使用的是同一个字段）；如果模型未配置或生成失败，会显示占位说明。若源码 docstring 与该文本不同，则会在 **Source Docstring** 中单独显示。

---

## 索引队列与任务进度

索引、提交影响分析和 issue 自动回复任务都通过 **串行队列** 执行（避免并发写入 Chroma / 本地仓库目录，也让本地仓库状态更可预测）。任务状态会持久化到 SQLite，因此服务重启后仍可查询历史记录。

- **列出任务**：`GET /api/index-jobs?limit=50&offset=0`（可选 `status` / `project_id` 过滤；响应中的 `total` 为完整匹配总数，`jobs` 为当前页，`limit` / `offset` 会回显请求值）
- **查看单个任务**：`GET /api/index-jobs/{job_id}`
- **取消任务**：`POST /api/index-jobs/{job_id}/cancel`（支持 `queued` 和 `running`；运行中任务会被终止）
- **重试失败/取消任务**：`POST /api/index-jobs/{job_id}/retry`
- **入队前预检查仓库**：`POST /api/index-jobs/precheck`

关键字段：

- **status**：`queued` / `running` / `succeeded` / `failed` / `cancelled`
- **progress**：0-100
- **step**：阶段名（例如 `clone_or_pull` / `parse_functions` / `generate_wiki` / `upsert_vector_store`）
- **message**：便于阅读的阶段说明

---

## 环境变量

大多数支持的设置也可以在 **`/admin/` → Settings** 中修改。UI 覆盖项会保存在 `DATA_DIR/ui_overrides.json` 中，并优先于 `.env` 生效。

### 最低可用配置

| 变量 | 说明 |
|------|------|
| `DATA_DIR` | 数据目录（默认 `./data`） |
| `EMBED_PROVIDER` | `ollama`（默认）或 `openai` |
| `EMBED_MODEL` | Embedding 模型名 / ID |
| `OLLAMA_BASE_URL` | 当 `EMBED_PROVIDER=ollama` 时必填 |
| `OPENAI_EMBED_BASE_URL` | 当 `EMBED_PROVIDER=openai` 时必填 |
| `OPENAI_EMBED_API_KEY` | 当 `EMBED_PROVIDER=openai` 时必填 |

如果你更换了 embedding provider、模型或向量维度，请清空 `DATA_DIR/chroma` 后重新索引。

### 常用可选配置

| 变量 | 说明 |
|------|------|
| `GITLAB_WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET` / `GITEA_WEBHOOK_SECRET` | Webhook 签名 secret |
| `GITLAB_ACCESS_TOKEN` / `GIT_HTTPS_TOKEN` | 私有仓库 HTTPS clone token |
| `GIT_HTTPS_USERNAME` | HTTPS Basic 用户名（默认 `oauth2`；GitHub 请用 `x-access-token`） |
| `CONTENT_LANGUAGE` | `zh` 或 `en`；控制生成内容语言 |
| `INDEX_EXCLUDE_PATTERNS` | 索引时额外跳过的 glob 模式 |
| `WIKI_BACKEND` | `mkdocs` / `starlight` / `vitepress` |
| `WIKI_ENABLED` | 设为 `false` / `0` 时关闭 wiki 生成 |

### LLM 配置

`LLM_PROVIDER` 支持 `openai`（默认）、`azure_openai` 或 `dify`。只需配置所选 provider 对应的变量。

| 变量 | 说明 |
|------|------|
| `LLM_PROVIDER` | `openai` / `azure_openai` / `dify` |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | OpenAI-compatible 聊天配置 |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_VERSION`, `AZURE_OPENAI_DEPLOYMENT` | Azure OpenAI 配置 |
| `DIFY_API_KEY`, `DIFY_BASE_URL` | Dify 配置 |

### 高级控制项

| 变量 | 说明 |
|------|------|
| `REPOS_CACHE_MAX_GB` / `REPOS_CACHE_MAX_COUNT` | 仓库镜像缓存限制 |
| `SKIP_VECTOR_STORE` | 本次运行跳过 Chroma upsert |
| `INCREMENTAL_INDEX` / `FORCE_FULL_INDEX` | 控制增量索引还是全量索引 |
| `WIKI_KEEP_WORK` | 保留 wiki 构建工作目录 |
| `WIKI_MAX_FILE_PAGES` / `WIKI_SYMBOL_ROWS_PER_FILE` | wiki 构建限制 |
| `NPM_REGISTRY` | wiki 构建时可选的 npm registry 覆盖 |

---

## 数据与持久化

默认都存放在 `DATA_DIR` 下：

- **仓库镜像**：`DATA_DIR/repos/<project_id>/...`（可通过 `REPOS_CACHE_MAX_GB` / `REPOS_CACHE_MAX_COUNT` 自动删除最近最少使用的**其他**项目镜像以节省磁盘；不会删除当前正在索引的仓库）
- **向量库**：`DATA_DIR/chroma/`
- **任务数据库**：`DATA_DIR/index_jobs.sqlite3`
- **项目向量索引元数据**：`DATA_DIR/project_index.sqlite3`（包含 `doc_count`、显示名称，以及增量索引字段 `last_indexed_commit` / `last_embed_model`）
- **影响分析历史**：`DATA_DIR/impact_analysis.sqlite3`
- **Issue 自动化状态**：`DATA_DIR/project_issues.sqlite3`、`DATA_DIR/issue_reply_job_payloads.sqlite3` 及相关 UI 覆盖 / 审计文件
- **静态 Wiki**：`DATA_DIR/wiki_sites/<project_id>/site/` 以及 `manifest.json`（中间目录 `wiki_work/` 默认会删除，除非设置 `WIKI_KEEP_WORK=1`）

---

## 本地开发

### 后端

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env
cd backend && uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

### 前端

```bash
cd frontend && npm install && npm run dev
```

当前后端与前端分开运行时，请设置 `CORS_ORIGINS=http://localhost:5173`。

### 说明

- 如果你从 `backend/` 目录启动，默认 `DATA_DIR=./data` 会解析为 `backend/data/`。
- 队列 worker 会随 API 服务自动启动。
- 如果函数解析返回 0 个结果，索引器会自动回退到文件级 chunk。

---

## README 维护规则

当你新增或修改任何公开 API、队列行为、环境变量或管理页面时：

- 在同一个 PR 中同时更新 `README.md` 与 `README.zh-CN.md`。
- 保持两个文件的章节顺序和接口覆盖范围一致。
- 至少确保一个可运行的 curl 示例在变更后仍然有效。

---

## 许可证

[MIT](LICENSE)
