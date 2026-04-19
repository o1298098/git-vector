# Git Code Indexing → Vector Store (Chroma) → Semantic Search (Dify / Admin UI)

**Languages**: **English** | [中文](README.zh-CN.md)

This service indexes **Git repositories** from common hosts (GitLab, GitHub, Gitea) or **any clone URL** (via manual trigger) into a searchable vector knowledge base. On `main`/`master` push webhooks—or when you call the trigger API—it pulls code, chunks it at the **function level** (falls back to **file level** when parsing yields zero functions), optionally generates a one-line description per chunk via an LLM, then embeds and upserts into Chroma. You can query via HTTP APIs, use the bundled admin UI, feed hits into Dify (API Tool), or call the **code Q&A** endpoints.

## Screenshots

Admin UI (`/admin/`): **Overview** with indexed projects, quick links, and **Semantic search** with natural-language queries over the vector index.

| Overview | Semantic search |
|----------|-----------------|
| ![Admin overview — indexed projects and shortcuts](docs/images/overview.png) | ![Semantic search — query and ranked code snippets](docs/images/semantic-search.png) |

---

## What you get

- **Auto indexing**: webhooks for **GitLab**, **GitHub**, and **Gitea** on `main`/`master` push (serial worker avoids concurrent write failures); other hosts can use **manual trigger** or CI calling the same enqueue API
- **Commit impact analysis**: push webhooks can also enqueue a project-wide impact analysis job that evaluates changed files, changed modules, affected areas, cross-system impact, risks, validation focus, and suggested reviewers
- **Issue automation**: GitLab, GitHub, and Gitea/Gitee issue events can be stored as a project issue stream, analyzed with retrieved code context, and optionally auto-replied to through the provider API
- **Project detail workspace**: the admin UI includes repository summary, issue management, chat-like issue detail history, impact analysis history, and repository-specific automation settings
- **Progress tracking**: returns a `job_id` on enqueue; query job status/progress anytime
- **Semantic search**: results include `path`, `name`, `start_line`, `end_line`, etc. for quick navigation
- **Code Q&A** (optional LLM): `POST /api/code-chat` and streaming variant (see OpenAPI at `/docs`)

---

## 30-second quick start

```bash
cp .env.example .env
docker compose up -d
curl "http://localhost:8000/health"
```

Then open:

- `http://localhost:8000/docs` for OpenAPI
- `http://localhost:8000/admin/` for admin UI

Minimum required settings before first useful indexing:

- **Embeddings** (see [Environment variables](#environment-variables)): default **`EMBED_PROVIDER=ollama`** needs **`OLLAMA_BASE_URL`** and **`EMBED_MODEL`**; use **`EMBED_PROVIDER=openai`** with **`OPENAI_EMBED_BASE_URL`**, **`OPENAI_EMBED_API_KEY`**, and an OpenAI **`EMBED_MODEL`** (e.g. `text-embedding-3-small`). Embedding OpenAI settings are **not** the same as chat `OPENAI_*`.
- **Private HTTPS repos (optional)**: `GIT_HTTPS_TOKEN` or `GITLAB_ACCESS_TOKEN`
- **Webhook signature verification (recommended for non-LAN)**: set each platform secret

---

## Repository layout

| Path | Purpose |
|------|---------|
| `backend/app/` | Python / FastAPI service, indexing, wiki, vector store |
| `backend/requirements.txt` | Backend dependencies |
| `frontend/` | React + Vite admin UI (built assets served at `/admin/`) |
| `docs/images/` | README screenshots |
| `LICENSE` | MIT license |
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
describe_chunks (optional): one-line descriptions via `LLM_PROVIDER` (Dify / Azure OpenAI / OpenAI-compatible)
  ↓
generate_wiki: static wiki (MkDocs / Starlight / VitePress) under DATA_DIR/wiki_sites
  ↓
upsert_vector_store: embeddings (`EMBED_PROVIDER`: Ollama or OpenAI-compatible) → Chroma upsert
  ↓
query/search: semantic retrieval (for Dify/frontend)

Additional webhook-driven automation
  ↓
Push webhook → enqueue `impact_analysis` → project-wide commit impact analysis → persist impact run history
  ↓
Issue / comment webhook → store project issue stream → retrieve related code context → decide whether to auto-reply → optionally post back to Git provider
```

---

## Quick start (Docker)

### 1) Configure `.env`

```bash
cp .env.example .env
```

Typical minimum config:

- **Private HTTPS repos**: set `GITLAB_ACCESS_TOKEN` and/or `GIT_HTTPS_TOKEN` (see [Private HTTPS clone](#private-https-clone)); for **GitHub PAT** use `GIT_HTTPS_USERNAME=x-access-token`
- **Embeddings**: set **`EMBED_PROVIDER`** (`ollama` or `openai`) and the matching variables (see [Environment variables](#environment-variables)); **changing provider or embedding dimension requires clearing `DATA_DIR/chroma` and re-indexing**
- **Optional LLM descriptions / code chat**: set **`LLM_PROVIDER`** to `dify`, `azure_openai`, or `openai` (default `openai`) and configure only that provider’s keys (see [LLM provider](#llm-provider))

### 2) Start

```bash
docker compose up -d
```

- **Service**: `http://localhost:8000`
- **Docs**: `http://localhost:8000/docs`
- **Rebuild after code changes**: `docker compose build --no-cache && docker compose up -d`

---

## Webhooks (indexing, impact analysis, issue automation)

Push webhook routes only enqueue indexing / impact-analysis jobs on **`main` or `master`**. Successful enqueue returns a `job_id` in the JSON body.

If the corresponding **secret env var is unset**, signature verification is **skipped** (convenient for LAN testing; **not recommended** on the public internet).

What webhooks can do now:

- **Push events**: enqueue repository indexing and project-wide commit impact analysis
- **Issue events**: store issue metadata and issue message history for the project detail page
- **Issue/comment events**: analyze the latest user message with retrieved code context and optionally auto-post a reply through the provider API

### GitLab

In the project **Settings → Webhooks**:

- **URL**: `http://<host>:8000/webhook/gitlab`
- **Secret**: same as `GITLAB_WEBHOOK_SECRET` (sent/verified per your GitLab setup)
- **Events**: enable **Push events** and **Issue events**; if your GitLab version emits issue changes as work items, enable the matching work item event as well
- Push events can enqueue indexing and commit impact analysis
- Issue / note events can update the project issue stream and trigger auto-reply analysis

### GitHub

In the repo **Settings → Webhooks → Add webhook**:

- **Payload URL**: `http://<host>:8000/webhook/github`
- **Content type**: `application/json`
- **Secret**: same as `GITHUB_WEBHOOK_SECRET` (HMAC SHA-256, header `X-Hub-Signature-256`)
- **Events**: enable **Push**, **Issues**, and **Issue comment** (ping events are ignored with `200`)
- Push events can enqueue indexing and commit impact analysis
- Issue creation and follow-up comments can trigger issue analysis and optional auto-replies

### Gitea / Gitee

In the repo **Settings → Webhooks**:

- **URL**: `http://<host>:8000/webhook/gitea`
- **Secret**: same as `GITEA_WEBHOOK_SECRET` (header `X-Gitea-Signature`, HMAC-SHA256 hex of raw body)
- **Events**: enable **Push** and issue-related events supported by your provider
- Push events can enqueue indexing and commit impact analysis
- Issue / comment events can update the issue stream and trigger optional auto-replies

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

## Commit impact analysis

Commit impact analysis can be triggered by push webhooks or internal job retries. The analyzer works against the project mirror on the server, recalls vector context, and produces a project-wide assessment instead of only describing the changed files.

Typical output includes:

- `changed_files`
- `changed_modules`
- `affected_areas`
- `cross_system_impact`
- `risk_level` (`high` / `medium` / `low`)
- `verification_focus`
- LLM-generated `summary`, `impact_scope`, `risks`, `tests`, and `reviewers`

The project detail page exposes this through the **Impact** tab with run history, compact summaries, searchable changed files, and expandable risk / validation sections.

---

## Issue automation

Issue automation is provider-aware and currently supports GitLab, GitHub, and Gitea/Gitee style webhooks.

What it does:

- stores project-scoped issue metadata and message history
- keeps a chat-like issue detail timeline in the admin UI
- applies project-level auto-reply rules, reply templates, and human-review keywords
- retrieves related code context from the vector index before generating a reply
- can automatically post replies back to the Git provider when policy allows it
- avoids obvious self-trigger loops and keeps issue status in sync when issues are closed

The project detail page exposes this through the **Issue** tab, including issue list, issue detail conversation, rule editing, and issue job history.

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
- **DELETE** `/api/projects/{project_id}`: remove project vectors and metadata
- **POST** `/api/projects/{project_id}/reindex`: enqueue a rebuild for the project
- **GET** `/api/projects/{project_id}/vectors`: inspect stored vectors with pagination
- **GET** `/api/project/index-status?project_id=xxx`: check whether a project is indexed (`indexed/doc_count`)

### Admin / auth / operations APIs

- **Auth UI**: `GET /api/auth/status`, `POST /api/auth/login`, `GET /api/auth/me`
- **Admin settings**: `GET /api/admin/settings`
- **Storage insight**: `GET /api/admin/storage`
- **LLM usage metrics**: `GET /api/admin/llm-usage`
- **Code chat feedback**: `POST /api/code-chat/feedback`
- **Project summary**: `GET /api/projects/{project_id}/summary`
- **Project repo config**: `PUT /api/projects/{project_id}/repo-config`
- **Project issue rules**: `GET/PUT /api/projects/{project_id}/issue-rules`
- **Project issues list/detail**: `GET /api/projects/{project_id}/issues`, `GET /api/projects/{project_id}/issues/{provider}/{issue_number}`
- **Project impact history**: `GET /api/projects/{project_id}/impact-runs`
- **Project issue jobs**: `GET /api/projects/{project_id}/issue-jobs`

### Static Wiki (MkDocs / Starlight / VitePress)

After `describe_chunks`, the worker runs a wiki build before vector upsert. Failures are logged only and do not block indexing. Default **`WIKI_BACKEND=mkdocs`** (Material, Python-only). **`starlight`** or **`vitepress`** need **Node.js + npm** (included in this repo’s Dockerfile; install them yourself on bare metal). The first build runs `npm install` under `wiki_work/<project_id>` (npm registry access required). Output: `DATA_DIR/wiki_sites/<project_id>/site/`, served by the API.

- **Browse**: `http://<host>:8000/wiki/<project_id>/site/` (same `project_id` rules as under `repos/`)
- **Metadata**: `GET /api/wiki/{project_id}` → last `manifest.json` (includes `wiki_backend`, commit, timestamps, counts)

Pages include overview, architecture (when an LLM is configured), file index (tree), per-file symbol pages, and a symbol table (split into parts when large). MkDocs uses Lunr search; Starlight/VitePress use built-in local search. On each symbol, **Functionality** shows only the **LLM-generated** one-line description from the indexing pipeline (same field as in the vector store); if the model is not configured or generation failed, a placeholder explains that. When a source docstring differs from that text, it appears separately under **Source Docstring**.

---

## Index queue & job progress

Indexing, commit impact analysis, and issue auto-reply jobs run through a **serial queue** (avoids concurrent writes to Chroma / local repo dirs and keeps local repo state predictable). Job state is persisted in SQLite so you can still query history after restarts.

- **List jobs**: `GET /api/index-jobs?limit=50&offset=0` (optional `status` / `project_id` filters; response `total` is the full match count, `jobs` is the current page, `limit`/`offset` echo the request)
- **Get one job**: `GET /api/index-jobs/{job_id}`
- **Cancel a job**: `POST /api/index-jobs/{job_id}/cancel` (supports `queued` and `running`; running jobs are terminated)
- **Retry a failed/cancelled job**: `POST /api/index-jobs/{job_id}/retry`
- **Precheck a repo before enqueue**: `POST /api/index-jobs/precheck`

Key fields:

- **status**: `queued` / `running` / `succeeded` / `failed` / `cancelled`
- **progress**: 0-100
- **step**: stage name (e.g. `clone_or_pull` / `parse_functions` / `generate_wiki` / `upsert_vector_store`)
- **message**: human-friendly stage message

---

## Environment variables

Most supported settings can also be changed from **`/admin/` → Settings**. UI overrides are stored in `DATA_DIR/ui_overrides.json` and take precedence over `.env`.

### Minimum useful config

| Variable | Description |
|------|------|
| `DATA_DIR` | Data directory (default `./data`) |
| `EMBED_PROVIDER` | `ollama` (default) or `openai` |
| `EMBED_MODEL` | Embedding model name / id |
| `OLLAMA_BASE_URL` | Required when `EMBED_PROVIDER=ollama` |
| `OPENAI_EMBED_BASE_URL` | Required when `EMBED_PROVIDER=openai` |
| `OPENAI_EMBED_API_KEY` | Required when `EMBED_PROVIDER=openai` |

If you change embedding provider, model, or vector dimension, clear `DATA_DIR/chroma` and re-index.

### Common optional settings

| Variable | Description |
|------|------|
| `GITLAB_WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET` / `GITEA_WEBHOOK_SECRET` | Webhook signature secrets |
| `GITLAB_ACCESS_TOKEN` / `GIT_HTTPS_TOKEN` | HTTPS clone token for private repositories |
| `GIT_HTTPS_USERNAME` | HTTPS basic username (`oauth2` default; GitHub: `x-access-token`) |
| `CONTENT_LANGUAGE` | `zh` or `en`; controls generated content language |
| `INDEX_EXCLUDE_PATTERNS` | Extra glob patterns to skip during indexing |
| `WIKI_BACKEND` | `mkdocs` / `starlight` / `vitepress` |
| `WIKI_ENABLED` | Disable wiki generation when set to `false` / `0` |

### LLM config

`LLM_PROVIDER` supports `openai` (default), `azure_openai`, or `dify`. Configure only the variables for the selected provider.

| Variable | Description |
|------|------|
| `LLM_PROVIDER` | `openai` / `azure_openai` / `dify` |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | OpenAI-compatible chat config |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_VERSION`, `AZURE_OPENAI_DEPLOYMENT` | Azure OpenAI config |
| `DIFY_API_KEY`, `DIFY_BASE_URL` | Dify config |

### Advanced controls

| Variable | Description |
|------|------|
| `REPOS_CACHE_MAX_GB` / `REPOS_CACHE_MAX_COUNT` | Repo mirror cache limits |
| `SKIP_VECTOR_STORE` | Skip Chroma upsert for a run |
| `INCREMENTAL_INDEX` / `FORCE_FULL_INDEX` | Control incremental vs full indexing |
| `WIKI_KEEP_WORK` | Keep wiki build work directory |
| `WIKI_MAX_FILE_PAGES` / `WIKI_SYMBOL_ROWS_PER_FILE` | Wiki build limits |
| `NPM_REGISTRY` | Optional npm registry override for wiki builds |

---

## Data & persistence

By default under `DATA_DIR`:

- **Repo mirrors**: `DATA_DIR/repos/<project_id>/...` (optional `REPOS_CACHE_MAX_GB` / `REPOS_CACHE_MAX_COUNT` to auto-remove least-recently-used **other** project mirrors to save disk; never deletes the repo for the job currently indexing)
- **Vector store**: `DATA_DIR/chroma/`
- **Jobs DB**: `DATA_DIR/index_jobs.sqlite3`
- **Project vector index metadata**: `DATA_DIR/project_index.sqlite3` (`doc_count`, display name, plus incremental fields `last_indexed_commit` / `last_embed_model`)
- **Impact analysis history**: `DATA_DIR/impact_analysis.sqlite3`
- **Issue automation state**: `DATA_DIR/project_issues.sqlite3`, `DATA_DIR/issue_reply_job_payloads.sqlite3`, and related UI override / audit files
- **Static wiki**: `DATA_DIR/wiki_sites/<project_id>/site/` plus `manifest.json` (intermediate `wiki_work/` removed unless `WIKI_KEEP_WORK=1`)

---

## Development (local)

### Backend

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env
cd backend && uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

### Frontend

```bash
cd frontend && npm install && npm run dev
```

Set `CORS_ORIGINS=http://localhost:5173` when running the frontend separately.

### Notes

- If you start from `backend/`, default `DATA_DIR=./data` resolves to `backend/data/`.
- The queue worker starts automatically with the API service.
- If function parsing returns zero hits, the indexer falls back to file-level chunks.

---

## README maintenance rule

When adding or changing any public API, queue behavior, environment variable, or admin page:

- Update **both** `README.md` and `README.zh-CN.md` in the same PR.
- Keep the same section order and endpoint coverage in both files.
- Ensure at least one runnable curl example still works after the change.

---

## License

[MIT](LICENSE)
