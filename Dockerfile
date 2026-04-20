FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# tree-sitter-language-pack 默认在首次 get_parser 时从 GitHub 拉 parsers.json / .so；
# 内网或受限环境会失败。构建阶段在有外网时预下载并写入镜像，运行期不再访问 GitHub。
# 语言列表与 backend/app/code_parser.py 中实际用到的解析器一致（tsx 由 typescript 解析，无需单独下载）。
ENV TSLP_CACHE_DIR=/var/cache/tree-sitter-language-pack
RUN mkdir -p "$TSLP_CACHE_DIR" && python -c "\
from tree_sitter_language_pack import download; \
download(['python', 'javascript', 'typescript', 'go', 'java', 'csharp', 'rust', 'ruby', 'php', 'c', 'cpp'])\
"

COPY backend/app ./app
COPY frontend ./frontend
RUN cd frontend && npm install && npm run build

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
