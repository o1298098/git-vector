#!/usr/bin/env bash
# 使用当前代码 + 你提供的环境变量，对 remote-play 仓库跑一遍索引（不写向量库，避免本地 chromadb 崩溃）
set -e
cd "$(dirname "$0")/.."

export GITLAB_WEBHOOK_SECRET=
export GITLAB_ACCESS_TOKEN=
export DIFY_API_KEY="${DIFY_API_KEY:-app-ZWpUqbDkd6cYmmTbocH28l8q}"
export DIFY_BASE_URL="${DIFY_BASE_URL:-http://218.13.87.222:43998/v1}"
export OPENAI_API_KEY=
export OPENAI_BASE_URL=
export DATA_DIR="${DATA_DIR:-./data}"
# 本地测试不写 Chroma，只验证：克隆 → 解析 → Dify 描述
export SKIP_VECTOR_STORE=1

REPO_URL="${1:-http://gitlab.o1298098.xyz/o1298098/remote-play.git}"
PROJECT_ID="${2:-o1298098/remote-play}"
export REPO_URL PROJECT_ID

echo "Using DIFY_BASE_URL=$DIFY_BASE_URL DATA_DIR=$DATA_DIR"
echo "Repo: $REPO_URL Project: $PROJECT_ID"
echo "Running index pipeline (vector store write skipped)..."
export PYTHONPATH="$(pwd)/backend${PYTHONPATH:+:$PYTHONPATH}"
. .venv/bin/activate
python3 -c "
import logging
import os
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
from app.indexer import run_index_pipeline
repo_url = os.environ.get('REPO_URL', 'http://gitlab.o1298098.xyz/o1298098/remote-play.git')
project_id = os.environ.get('PROJECT_ID', 'o1298098/remote-play')
run_index_pipeline(repo_url, project_id)
print('Done.')
"
