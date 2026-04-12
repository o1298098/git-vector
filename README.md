# Git Code Indexing → Vector Store (Chroma) → Semantic Search (Dify / Admin UI)

**Languages**: **English** | [中文](README.zh-CN.md)

This service indexes **Git repositories** from common hosts (GitLab, GitHub, Gitea) or **any clone URL** (via manual trigger) into a searchable vector knowledge base. On `main`/`master` push webhooks—or when you call the trigger API—it pulls code, chunks it at the **function level** (falls back to **file level** when parsing yields zero functions), optionally generates a one-line description per chunk via an LLM, then embeds and upserts into Chroma. You can query via HTTP APIs, use the bundled admin UI, feed hits into Dify (API Tool), or call the **code Q&A** endpoints.

---

## What you get

- **Auto indexing**: webhooks for **GitLab**, **GitHub**, and **Gitea** on `main`/`master` push (serial worker avoids concurrent write failures); other hosts can use **manual trigger** or CI calling the same enqueue API
- **Progress tracking**: returns a `job_id` on enqueue; query job status/progress anytime
- **Semantic search**: results include `path`, `name`, `start_line`, `end_line`, etc. for quick navigation
- **Code Q&A** (optional LLM): `POST /api/code-chat` and streaming variant (see OpenAPI at `/docs`)

---

## Repository layout

| Path | Purpose |
|------|---------|
| `backend/app/` | Python / FastAPI service, indexing, wiki, vector store |
| `backend/requirements.txt` | Backend dependencies |
| `frontend/` | React + Vite admin UI (built assets served at `/admin/`) |
| `scripts/` | Helper scripts |

---

## Workflow (matches the code)

```text
Webhook push (GitLab / GitHub / Gitea, main/master) / Manual trigger (any Git URL)
  ↓
Enqueue job (SQLite persistence, single serial worker)
  ↓
clone_or_pull: clone/pull repo (optional HTTPS auth: GIT_HTTPS_TOKEN or GITLAB_ACCESS_TOKEN, see below)
  ↓
collect_files: scan common code/config files (skip `node_modules` / `.git` / `.env` etc.)
  ↓
parse_functions: Tree-sitter function-level parsing (0 results → file-level fallback)
  ↓
describe_chunks (optional): generate one-line descriptions via Dify / Azure OpenAI / OpenAI
  ↓
generate_wiki: static wiki (MkDocs / Starlight / VitePress) under DATA_DIR/wiki_sites
  ↓
upsert_vector_store: embeddings → Chroma upsert
  ↓
query/search: semantic retrieval (for Dify/frontend)
```

---

## Quick start (Docker)

### 1) Configure `.env`

```bash
cp .env.example .env
```

Typical minimum config:

- **Private HTTPS repos**: set `GITLAB_ACCESS_TOKEN` and/or `GIT_HTTPS_TOKEN` (see [Private HTTPS clone](#private-https-clone)); for **GitHub PAT** use `GIT_HTTPS_USERNAME=x-access-token`
- **Embeddings**: ensure `OLLAMA_BASE_URL` is reachable and Ollama has the model named in `EMBED_MODEL` (default in `.env.example`)
- **Optional LLM descriptions / code chat**: configure one provider (see “LLM priority”)

### 2) Start

```bash
docker compose up -d
```

- **Service**: `http://localhost:8000`
- **Docs**: `http://localhost:8000/docs`
- **Rebuild after code changes**: `docker compose build --no-cache && docker compose up -d`

---

## Webhooks (auto-index on push)

All webhook routes only enqueue on **`main` or `master`** pushes. Successful enqueue returns `job_id` in the JSON body.

If the corresponding **secret env var is unset**, signature verification is **skipped** (convenient for LAN testing; **not recommended** on the public internet).

### GitLab

In the project **Settings → Webhooks**:

- **URL**: `http://<host>:8000/webhook/gitlab`
- **Secret**: same as `GITLAB_WEBHOOK_SECRET` (sent/verified per your GitLab setup)
- **Events**: **Push events**
- Handler accepts `object_kind=push` only.

### GitHub

In the repo **Settings → Webhooks → Add webhook**:

- **Payload URL**: `http://<host>:8000/webhook/github`
- **Content type**: `application/json`
- **Secret**: same as `GITHUB_WEBHOOK_SECRET` (HMAC SHA-256, header `X-Hub-Signature-256`)
- **Events**: **Just the push event** (ping events are ignored with `200`)

### Gitea

In the repo **Settings → Webhooks**:

- **URL**: `http://<host>:8000/webhook/gitea`
- **Secret**: same as `GITEA_WEBHOOK_SECRET` (header `X-Gitea-Signature`, HMAC-SHA256 hex of raw body)
- **Events**: **Push**

---

## Private HTTPS clone

For private repositories over HTTPS, the worker injects credentials into the clone URL when the clean URL has no embedded userinfo:

| Variable | Role |
|----------|------|
| `GIT_HTTPS_TOKEN` | If set, **takes precedence** over `GITLAB_ACCESS_TOKEN` |
| `GITLAB_ACCESS_TOKEN` | Still supported (e.g. GitLab `read_repository` PAT) |
| `GIT_HTTPS_USERNAME` | HTTP basic username for the token; default when empty is **`oauth2`** (GitLab). For **GitHub**, set **`x-access-token`** |

You can also set **`GIT_HTTPS_USERNAME`** from the admin **Settings** UI (`/admin/`).

---

## Manual indexing (without Webhook)

### Option A: `/webhook/trigger`

```bash
curl -X POST "http://localhost:8000/webhook/trigger" \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://github.com/acme/backend.git","project_id":"acme/backend","project_name":"Display name"}'
```

Use any **HTTPS or SSH** URL your runtime can `git clone`. Optional **`project_name`**: human-readable label (e.g. Chinese name). Stored on the job and shown on the Wiki home page, site title, and `manifest.json`.

### Option B: `/api/index-jobs/enqueue` (equivalent enqueue API)

```bash
curl -X POST "http://localhost:8000/api/index-jobs/enqueue" \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://github.com/acme/backend.git","project_id":"acme/backend","project_name":"Display name"}'
```

---

## Query (for Dify / frontend)

### Semantic search

- **POST** `/api/query`

```bash
curl -X POST "http://localhost:8000/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query":"How is user login implemented?","project_id":"my-repo","top_k":10}'
```

- **GET** `/api/search`

```bash
curl "http://localhost:8000/api/search?q=login&project_id=my-repo&top_k=10"
```

Response shape:

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

### Projects / index status

- **GET** `/api/projects`: list indexed projects and doc counts; each item includes `project_name` (display name, may be `null`); optional `q` (matches `project_id` or `project_name` substring), `limit`/`offset` pagination (omit `limit` for full list, backward compatible)
- **GET** `/api/project/index-status?project_id=xxx`: check whether a project is indexed (`indexed/doc_count`)

### Static Wiki (MkDocs / Starlight / VitePress)

After `describe_chunks`, the worker runs a wiki build before vector upsert. Failures are logged only and do not block indexing. Default **`WIKI_BACKEND=mkdocs`** (Material, Python-only). **`starlight`** or **`vitepress`** need **Node.js + npm** (included in this repo’s Dockerfile; install them yourself on bare metal). The first build runs `npm install` under `wiki_work/<project_id>` (npm registry access required). Output: `DATA_DIR/wiki_sites/<project_id>/site/`, served by the API.

- **Browse**: `http://<host>:8000/wiki/<project_id>/site/` (same `project_id` rules as under `repos/`)
- **Metadata**: `GET /api/wiki/{project_id}` → last `manifest.json` (includes `wiki_backend`, commit, timestamps, counts)

Pages include overview, architecture (when an LLM is configured), file index (tree), per-file symbol pages, and a symbol table (split into parts when large). MkDocs uses Lunr search; Starlight/VitePress use built-in local search. On each symbol, **功能说明** shows only the **LLM-generated** one-line description from the indexing pipeline (same field as in the vector store); if the model is not configured or generation failed, a placeholder explains that. When a source docstring differs from that text, it appears separately under **源码文档**.

---

## Index queue & job progress

Indexing runs through a **serial queue** (avoids concurrent writes to Chroma / local repo dirs). Job state is persisted in SQLite so you can still query history after restarts.

- **List jobs**: `GET /api/index-jobs?limit=50&offset=0` (optional `status` / `project_id` filters; response `total` is the full match count, `jobs` is the current page, `limit`/`offset` echo the request)
- **Get one job**: `GET /api/index-jobs/{job_id}`

Key fields:

- **status**: `queued` / `running` / `succeeded` / `failed` / `cancelled`
- **progress**: 0-100
- **step**: stage name (e.g. `clone_or_pull` / `parse_functions` / `generate_wiki` / `upsert_vector_store`)
- **message**: human-friendly stage message

---

## Environment variables

| Variable | Description |
|------|------|
| `GITLAB_WEBHOOK_SECRET` | GitLab webhook secret (if unset, verification skipped) |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook secret for `X-Hub-Signature-256` (if unset, skipped) |
| `GITEA_WEBHOOK_SECRET` | Gitea webhook secret for `X-Gitea-Signature` (if unset, skipped) |
| `GITLAB_ACCESS_TOKEN` | HTTPS clone token (private repos); still used if `GIT_HTTPS_TOKEN` is empty |
| `GIT_HTTPS_TOKEN` | HTTPS clone token; **overrides** `GITLAB_ACCESS_TOKEN` when set |
| `GIT_HTTPS_USERNAME` | HTTPS basic username for clone (`oauth2` default; GitHub: `x-access-token`) |
| `GITLAB_EXTERNAL_URL` | Optional base URL for “open repo” links when no `repo_url` is stored (GitLab-style paths) |
| `DIFY_API_KEY` | Dify API key (used to generate one-line chunk descriptions) |
| `DIFY_BASE_URL` | Dify API base URL (default `https://api.dify.ai/v1`) |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI key |
| `AZURE_OPENAI_ENDPOINT` | Azure endpoint (e.g. `https://xxx.cognitiveservices.azure.com`) |
| `AZURE_OPENAI_VERSION` | Azure API version |
| `AZURE_OPENAI_DEPLOYMENT` | Azure deployment name |
| `OPENAI_API_KEY` | OpenAI (or compatible) key |
| `OPENAI_BASE_URL` | Compatible base URL (default `https://api.openai.com/v1`) |
| `OPENAI_MODEL` | Model/deployment name |
| `DATA_DIR` | Data directory (default `./data`; commonly `/data` in containers) |
| `OLLAMA_BASE_URL` | Ollama base URL (default `http://localhost:11434` in code; Docker examples often use `http://host.docker.internal:11434`) |
| `EMBED_MODEL` | Ollama **embeddings** model name (must exist in Ollama). **If you change the model, clear `DATA_DIR/chroma` and re-index** (dimension changes). |
| `SKIP_VECTOR_STORE` | If `1`, runs clone/parse/(optional LLM) but skips Chroma upsert (useful for local validation). |
| `WIKI_BACKEND` | `mkdocs` (default) / `starlight` / `vitepress` (last two need Node.js + npm; Docker image includes them). |
| `WIKI_ENABLED` | `false` / `0` disables wiki generation after describe (default: on). |
| `SKIP_WIKI` | `1` skips wiki for a run without changing `WIKI_ENABLED`. |
| `WIKI_KEEP_WORK` | `1` keeps intermediate `wiki_work/<project_id>` for debugging. |
| `WIKI_MAX_FILE_PAGES` | Max per-path file pages (default `5000`). |
| `WIKI_SYMBOL_ROWS_PER_FILE` | Max symbol table rows per Markdown file (default `4000`). |
| `NPM_REGISTRY` | Optional. When using `starlight` / `vitepress`, sets `npm_config_registry` for npm if non-empty. Or set **`npm_config_registry`** / **`NPM_CONFIG_REGISTRY`** in the environment (the uppercase form is mapped to `npm_config_registry` for subprocesses). |

### LLM priority (only one will be used)

For generating a one-line description per function/file chunk, providers are selected in this priority order:

1. **Dify**: `DIFY_API_KEY` (optional `DIFY_BASE_URL`)
2. **Azure OpenAI**: `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`
3. **OpenAI-compatible**: `OPENAI_API_KEY`

If no LLM is configured, indexing and retrieval still work; results simply won’t include natural language descriptions (but still include path/name/code snippets).

---

## Data & persistence

By default under `DATA_DIR`:

- **Repo mirrors**: `DATA_DIR/repos/<project_id>/...`
- **Vector store**: `DATA_DIR/chroma/`
- **Jobs DB**: `DATA_DIR/index_jobs.sqlite3`
- **Static wiki**: `DATA_DIR/wiki_sites/<project_id>/site/` plus `manifest.json` (intermediate `wiki_work/` removed unless `WIKI_KEEP_WORK=1`)

---

## Development (local)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env
cd backend && uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Admin UI local dev (optional, second terminal; set `CORS_ORIGINS=http://localhost:5173`):

```bash
cd frontend && npm install && npm run dev
```

Notes:

- When started from `backend/`, the default `DATA_DIR=./data` resolves to `backend/data/`; set `DATA_DIR=../data` in `.env` if you want data at the repository root.
- On startup the service attempts to start the indexing queue worker; vector store/embedding objects are typically loaded on first index or first query.
- If you see `No function-level chunks parsed ...; using file-level fallback`, parsing produced zero function chunks and the service fell back to file-level chunks (retrieval still works, but granularity is coarser).
