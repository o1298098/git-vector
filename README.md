# GitLab Code Indexing → Vector Store (Chroma) → Semantic Search (for Dify / Frontend)

**Languages**: **English** | [中文](README.zh-CN.md)

This service indexes GitLab repositories into a searchable vector knowledge base. On GitLab push (or manual trigger), it pulls code, chunks it at the **function level** (falls back to **file level** when parsing yields zero functions), optionally generates a one-line description per chunk via an LLM, then embeds and upserts into Chroma. You can query it via HTTP APIs and feed results into Dify (API Tool) or any client.

---

## What you get

- **Auto indexing**: queue indexing on GitLab `main/master` push (serial worker avoids concurrent write failures)
- **Progress tracking**: returns a `job_id` on enqueue; query job status/progress anytime
- **Semantic search**: results include `path`, `name`, `start_line`, `end_line`, etc. for quick navigation

---

## Workflow (matches the code)

```text
GitLab Push(main/master) / Manual trigger
  ↓
Enqueue job (SQLite persistence, single serial worker)
  ↓
clone_or_pull: clone/pull repo (optionally inject `GITLAB_ACCESS_TOKEN`)
  ↓
collect_files: scan common code/config files (skip `node_modules` / `.git` / `.env` etc.)
  ↓
parse_functions: Tree-sitter function-level parsing (0 results → file-level fallback)
  ↓
describe_chunks (optional): generate one-line descriptions via Dify / Azure OpenAI / OpenAI
  ↓
generate_wiki: MkDocs Material static site (search index) under DATA_DIR/wiki_sites
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

- **Private GitLab**: set `GITLAB_ACCESS_TOKEN` (needs `read_repository`)
- **Embeddings**: ensure `OLLAMA_BASE_URL` is reachable and Ollama has pulled `EMBED_MODEL`
- **Optional LLM descriptions**: configure one provider (see “LLM priority”)

### 2) Start

```bash
docker compose up -d
```

- **Service**: `http://localhost:8000`
- **Docs**: `http://localhost:8000/docs`
- **Rebuild after code changes**: `docker compose build --no-cache && docker compose up -d`

---

## GitLab Webhook

In your GitLab project **Settings → Webhooks**:

- **URL**: `http://<your-service-host>:8000/webhook/gitlab`
- **Secret token (optional)**: same as `.env` `GITLAB_WEBHOOK_SECRET`
- **Trigger**: enable **Push events**

Notes:

- Only handles `object_kind=push` and branch `main/master`
- On success, returns `job_id`: `{"status":"queued","project_id":"...","job_id":"..."}`

---

## Manual indexing (without Webhook)

### Option A: `/webhook/trigger`

```bash
curl -X POST "http://localhost:8000/webhook/trigger" \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://gitlab.com/group/my-repo.git","project_id":"my-repo"}'
```

### Option B: `/api/index-jobs/enqueue` (equivalent enqueue API)

```bash
curl -X POST "http://localhost:8000/api/index-jobs/enqueue" \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://gitlab.com/group/my-repo.git","project_id":"my-repo"}'
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

- **GET** `/api/projects`: list indexed projects and doc counts
- **GET** `/api/project/index-status?project_id=xxx`: check whether a project is indexed (`indexed/doc_count`)

### Static Wiki (MkDocs + site search)

After `describe_chunks`, the worker runs **MkDocs Material** before vector upsert. Failures are logged only and do not block indexing. Output: `DATA_DIR/wiki_sites/<project_id>/site/`, served by the API.

- **Browse**: `http://<host>:8000/wiki/<project_id>/site/` (same `project_id` rules as under `repos/`)
- **Metadata**: `GET /api/wiki/{project_id}` → last `manifest.json` (commit, timestamps, counts)

Pages include overview, architecture (when an LLM is configured), file index, per-file symbol pages, and a symbol table (split into parts when large). The theme search box uses a prebuilt full-text index (no extra search service).

---

## Index queue & job progress

Indexing runs through a **serial queue** (avoids concurrent writes to Chroma / local repo dirs). Job state is persisted in SQLite so you can still query history after restarts.

- **List jobs**: `GET /api/index-jobs?limit=50&offset=0` (optional `status` / `project_id` filters)
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
| `GITLAB_WEBHOOK_SECRET` | GitLab webhook secret token (if unset, signature verification is skipped) |
| `GITLAB_ACCESS_TOKEN` | Token for private repos |
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
| `OLLAMA_BASE_URL` | Ollama base URL (default `http://host.docker.internal:11434`; adjust for your setup) |
| `EMBED_MODEL` | Ollama embedding model name (e.g. `nomic-embed-text`, `mxbai-embed-large`). **If you change the model, clear `DATA_DIR/chroma` and re-index** (dimension changes). |
| `SKIP_VECTOR_STORE` | If `1`, runs clone/parse/(optional LLM) but skips Chroma upsert (useful for local validation). |
| `WIKI_ENABLED` | `false` / `0` disables MkDocs wiki generation after describe (default: on). |
| `SKIP_WIKI` | `1` skips wiki for a run without changing `WIKI_ENABLED`. |
| `WIKI_KEEP_WORK` | `1` keeps intermediate `wiki_work/<project_id>` for debugging. |
| `WIKI_MAX_FILE_PAGES` | Max per-path file pages (default `5000`). |
| `WIKI_SYMBOL_ROWS_PER_FILE` | Max symbol table rows per Markdown file (default `4000`). |

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
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Notes:

- On startup the service attempts to start the indexing queue worker; vector store/embedding objects are typically loaded on first index or first query.
- If you see `No function-level chunks parsed ...; using file-level fallback`, parsing produced zero function chunks and the service fell back to file-level chunks (retrieval still works, but granularity is coarser).
