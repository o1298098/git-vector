# GitLab 代码分析 → 向量库 → Dify 查询

GitLab 仓库 Push 后自动拉取代码、用 AI 生成功能说明、写入向量库，支持通过 API 或 Dify 进行语义查询，实现「AI 自动分析整个项目功能」。

## 流程（函数级）

```
GitLab Repo
    ↓
Repo Loader（克隆/拉取）
    ↓
Tree-sitter 解析（Python / JS·TS·TSX / Go / Java / C# / Rust / C·C++；TSX 使用 TypeScript 解析，React 中 `const X = () => {}` 会按函数提取）
    ↓
函数级 Chunk（每个函数/方法一条）；若无则自动退化为「按文件」chunk
    ↓
可选：LLM 批量生成一行功能描述（Dify / Azure OpenAI / OpenAI）
    ↓
Embedding（通过 Ollama `/api/embeddings`）→ Vector DB (Chroma)
    ↓
Dify / Chat：语义检索 → 精确定位「功能是否在代码中实现」及文件与行号
```

检索结果包含 `path`、`name`、`start_line`、`end_line`，便于跳转到具体实现。

## 快速开始（Docker）

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env：
# - 拉私有库：填 GITLAB_ACCESS_TOKEN
# - 生成功能描述：填 Dify 或 Azure OpenAI 或 OPENAI_*（见下方「LLM 与优先级」）
```

### 2. 启动

```bash
docker compose up -d
```

服务地址：`http://localhost:8000`，文档：`http://localhost:8000/docs`。**修改代码后需重新构建镜像**：`docker compose build --no-cache && docker compose up -d`。

### 3. GitLab Webhook

在 GitLab 项目 **Settings → Webhooks** 添加：

- **URL**: `http://<你的服务器>:8000/webhook/gitlab`
- **Secret**: 与 `.env` 中 `GITLAB_WEBHOOK_SECRET` 一致（可选）
- **Trigger**: 勾选 **Push events**

Push 到 `main`/`master` 后会自动触发索引。

### 4. 自建 GitLab 与私有仓库

- **Webhook URL**：填本服务对 GitLab **可访问**的地址。若 GitLab 与本服务在同一内网，例如本服务跑在 `192.168.1.100:8000`，则 URL 为 `http://192.168.1.100:8000/webhook/gitlab`；若通过 Nginx 暴露，则填对外域名。
- **私有仓库**：必须配置 `GITLAB_ACCESS_TOKEN`，否则拉取会 401/403。  
  - 在 GitLab：**User → Access Tokens** 创建 Token，勾选 **read_repository**（或至少包含读代码权限）。  
  - 将 Token 写入 `.env` 的 `GITLAB_ACCESS_TOKEN`，本服务会在克隆时自动把 Token 注入到 HTTP(S) 地址中（如 `https://oauth2:<token>@gitlab.xxx/group/repo.git`）。
- **自建 GitLab 的仓库地址**：一般为 `http(s)://<你的 GitLab 域名或 IP>/<group>/<repo>.git`，Webhook 发来的 `project.http_url` 即为此格式，无需改代码。
- **自签名 HTTPS**：若 GitLab 使用自签名证书，需保证运行本服务的环境（Docker 或本机）信任该证书，否则 `git clone` 可能报 SSL 错误；必要时可在克隆前配置 `git config --global http.sslVerify false`（仅建议在内网测试时使用）。

### 5. 手动触发索引（不配 Webhook 时）

```bash
curl -X POST http://localhost:8000/webhook/trigger \
  -H "Content-Type: application/json" \
  -d '{"repo_url": "https://gitlab.com/group/my-repo.git", "project_id": "my-repo"}'
```

自建 GitLab 时把 `repo_url` 换成你的地址，例如：  
`"repo_url": "http://gitlab.company.local/group/my-repo.git"`。配置了 `GITLAB_ACCESS_TOKEN` 后，私有仓库也可用同样方式触发。

### 6. 查询接口（供 Dify 或前端调用）

- **POST** `/api/query`  
  Body: `{"query": "用户登录是怎么实现的？", "project_id": "my-repo", "top_k": 10}`  
  返回语义检索到的功能说明片段（含 path、name、行号）。

- **GET** `/api/search?q=登录&project_id=my-repo&top_k=10`  
  同上，GET 形式。

在 Dify 中可建「API 工具」调用上述接口，把检索结果作为上下文做对话。

## 环境变量说明

| 变量 | 说明 |
|------|------|
| `GITLAB_WEBHOOK_SECRET` | Webhook 校验密钥，与 GitLab 中填写的 Secret 一致 |
| `GITLAB_ACCESS_TOKEN` | **自建 GitLab 私有库必填**。Personal Access Token，需具备 `read_repository`，用于克隆/拉取 |
| `DIFY_API_KEY` | Dify 应用 API Key，用于生成功能说明（对话型应用） |
| `DIFY_BASE_URL` | Dify API 地址，默认 `https://api.dify.ai/v1` |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI 密钥 |
| `AZURE_OPENAI_ENDPOINT` | Azure 端点，如 `https://xxx.cognitiveservices.azure.com` |
| `AZURE_OPENAI_VERSION` | API 版本，如 `2024-05-01-preview` |
| `AZURE_OPENAI_DEPLOYMENT` | 部署名，与 Azure 门户一致（如 `gpt-5.4`） |
| `OPENAI_API_KEY` | OpenAI 或兼容 API 的密钥 |
| `OPENAI_BASE_URL` | 兼容接口地址，默认 `https://api.openai.com/v1` |
| `OPENAI_MODEL` | 模型/部署名，默认 `gpt-4o-mini` |
| `DATA_DIR` | 数据目录，默认 `./data`；Docker 内可为 `/data` |
| `EMBED_MODEL` | **Ollama 中的向量模型名**，例如 `nomic-embed-text`、`mxbai-embed-large` 等。Docker compose 默认 `nomic-embed-text`，可在 `.env` 中覆盖。同一环境内请固定使用一个模型；更换模型后需清空 `DATA_DIR/chroma` 并重新触发索引（向量维度会变） |
| `OLLAMA_BASE_URL` | Ollama 服务地址，默认 `http://host.docker.internal:11434`（Docker 容器访问宿主机上的 Ollama，适用于 Mac/Windows）。若 Ollama 跑在其它主机或容器，请改为对应地址，如 `http://192.168.1.10:11434` |

### LLM 与优先级

用于「为函数/文件生成一行描述」的 LLM 按以下优先级选用（只用一个）：

1. **Dify**：若配置了 `DIFY_API_KEY` + `DIFY_BASE_URL`
2. **Azure OpenAI**：若配置了 `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`（使用官方 `openai` 包内 Azure SDK）
3. **OpenAI 兼容**：若配置了 `OPENAI_API_KEY`

不配置任何 LLM 时，仍会索引代码（path + 代码片段），仅无自然语言描述。

## 数据与持久化

- 克隆的仓库：在 `DATA_DIR/repos` 下，Docker 通过 volume `app_data` 持久化。
- 向量库：Chroma 数据在 `DATA_DIR/chroma`，同样由 `app_data` 持久化。

## 开发（本地调试）

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # 按需填写
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

- 服务启动时不预加载向量库与 embedding，`/health`、`/`、`/docs` 可正常访问。
- 首次触发 **索引**（Webhook 或 `/webhook/trigger`）或 **检索**（`/api/query`）时再加载 Chroma + fastembed（会下载多语言模型）。
- 本地测试索引但不想写向量库时：`SKIP_VECTOR_STORE=1` 下执行索引逻辑，仅验证克隆 + 解析 + LLM 描述。
- **构建前检查解析代码就绪**（无需依赖）：`python scripts/check_parse_ready.py`，通过后再 `docker compose build`。
- **测试 TS/TSX 能否解析出函数**：在项目根执行 `python scripts/test_parse_iot.py`（需已安装依赖）；或在 Docker 构建后执行 `docker compose run --rm app python scripts/test_parse_local.py`（内联代码，无需 clone），或 `python scripts/test_parse_iot.py`（需 clone，可用 `SKIP_CLONE=1` 使用已克隆仓库）。
- **日志「No function-level chunks parsed for xxx; using file-level fallback」**：表示该仓库在函数级解析时未得到任何 chunk（例如 374 个文件但 parser 未识别出函数），已自动退化为「按文件」chunk，检索仍可用，只是粒度为文件而非函数。

## 与 Dify 的配合方式

1. **本服务**：负责「GitLab → 索引 → 功能说明 → 向量库」和「检索 API」。
2. **Dify**：创建应用，添加「API 工具」调用本服务的 `POST /api/query`，把返回的 `results` 作为上下文，即可在对话中回答「这个项目/模块是做什么的」「某功能在哪」等问题。

整体效果：**GitLab Push → 自动索引 → 生成代码功能说明 → 向量库 → Dify 查询**，由 AI 自动分析整个项目功能。
