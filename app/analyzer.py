import logging
from typing import Any

from app.llm_client import get_llm_client

logger = logging.getLogger(__name__)

# 函数级：每批最多多少个函数发给 LLM 做一行描述
MAX_FUNCS_PER_BATCH = 20
# 每个函数代码截断长度（避免超长）
MAX_CODE_LEN = 1200

# 单次发给 LLM 的最大文件数/字符，避免超长（保留用于兼容）
MAX_FILES_PER_BATCH = 30
MAX_CHARS_PER_BATCH = 80_000


def describe_functions_batch(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    对函数级 chunk 批量调用 LLM 生成一行较为详细的中文描述，便于检索「功能是否在代码中实现」。
    若不配置 LLM 或为 file 级回退 chunk（kind==file）则跳过描述，直接返回。
    """
    if not chunks:
        return chunks
    # file 级回退时内容很长，不调 LLM，避免 400 / 超长
    if chunks and (chunks[0].get("kind") == "file"):
        return chunks

    client = get_llm_client()
    if not client:
        return chunks

    out: list[dict[str, Any]] = []
    for i in range(0, len(chunks), MAX_FUNCS_PER_BATCH):
        batch = chunks[i : i + MAX_FUNCS_PER_BATCH]
        parts = []
        for j, c in enumerate(batch):
            code = (c.get("code") or "")[:MAX_CODE_LEN]
            parts.append(f"[{j}] {c.get('path', '')} :: {c.get('name', '')}\n{code}")
        prompt = (
            "以下是一组函数/方法代码，请为每一个用**一行中文**较为详细地、准确地描述其功能。"
            "描述中可以包含：主要业务逻辑、关键输入输出、重要条件判断或副作用、依赖的外部服务或模块等，"
            "但不要凭空臆测与代码无关的业务含义。只输出描述本身，每行一个，与 [0][1]... 顺序严格对应，"
            "不要换行、不要编号、不要重复文件路径或函数名：\n\n"
            + "\n\n---\n\n".join(parts)
        )
        try:
            text = client.chat(
                system=(
                    "你是代码分析助手。根据提供的函数/方法代码，只输出一行中文描述，"
                    "可以适当详细，包含业务含义、关键输入输出、重要条件或副作用，"
                    "但不要换行、不要添加额外前缀。每一行只对应一个函数。"
                ),
                user=prompt,
            )
            lines = [ln.strip() for ln in (text or "").strip().split("\n") if ln.strip()]
            for j, c in enumerate(batch):
                desc = lines[j] if j < len(lines) else ""
                out.append({**c, "description": desc})
        except Exception as e:
            logger.warning("LLM describe batch failed: %s", e)
            out.extend(batch)
    return out


def _batch_files(files: list[tuple[str, str]]) -> list[list[tuple[str, str]]]:
    batches = []
    current: list[tuple[str, str]] = []
    current_len = 0
    for path, content in files:
        if len(current) >= MAX_FILES_PER_BATCH or current_len + len(content) > MAX_CHARS_PER_BATCH:
            if current:
                batches.append(current)
            current = []
            current_len = 0
        current.append((path, content))
        current_len += len(content)
    if current:
        batches.append(current)
    return batches


def _build_file_context(batch: list[tuple[str, str]]) -> str:
    parts = []
    for path, content in batch:
        parts.append(f"## {path}\n```\n{content[:8000]}{'...' if len(content) > 8000 else ''}\n```")
    return "\n\n".join(parts)


SYSTEM_PROMPT = """你是一个代码分析助手。根据提供的项目代码文件内容，用中文生成简洁的「功能说明」。
要求：
1. 按模块/文件归纳功能，说明这段代码在做什么、对外提供什么能力。
2. 输出多段说明，每段对应一个逻辑模块或文件，格式为：
   [模块名或文件路径]
   功能说明内容（一两句话即可）
3. 不要复制大段代码，只写自然语言说明。"""


def _user_prompt(files_context: str, project_id: str) -> str:
    return f"""项目标识: {project_id}

请分析以下代码并生成功能说明（多段，每段对应一个模块/文件）：

{files_context}

请直接输出多段 [模块/路径] + 功能说明，不要其他前缀。"""


def analyze_repo_and_describe(
    project_id: str,
    files: list[tuple[str, str]],
) -> list[dict[str, Any]]:
    """对仓库文件分批调用 LLM 生成功能说明，返回用于向量化的文档列表。"""
    client = get_llm_client()
    if not client:
        logger.warning("No LLM client configured, using file names as descriptions")
        return [
            {"path": path, "content": f"文件: {path}\n(未配置 LLM，未生成说明)", "metadata": {"path": path}}
            for path, _ in files[:200]
        ]

    all_chunks: list[dict[str, Any]] = []
    batches = _batch_files(files)

    for batch in batches:
        context = _build_file_context(batch)
        user = _user_prompt(context, project_id)
        try:
            text = client.chat(system=SYSTEM_PROMPT, user=user)
        except Exception as e:
            logger.exception("LLM call failed: %s", e)
            for path, content in batch:
                all_chunks.append({
                    "path": path,
                    "content": f"文件: {path}\n(分析失败: {e})",
                    "metadata": {"path": path},
                })
            continue

        # 简单解析：按 [xxx] 分段
        current_header = ""
        current_content: list[str] = []
        for line in (text or "").split("\n"):
            line = line.strip()
            if line.startswith("[") and "]" in line:
                if current_header or current_content:
                    content = "\n".join(current_content).strip()
                    if content:
                        all_chunks.append({
                            "path": current_header or "unknown",
                            "content": f"{current_header}\n{content}",
                            "metadata": {"path": current_header or "unknown"},
                        })
                idx = line.index("]")
                current_header = line[1:idx].strip()
                current_content = [line[idx + 1 :].strip()] if line[idx + 1 :].strip() else []
            else:
                current_content.append(line)
        if current_header or current_content:
            content = "\n".join(current_content).strip()
            if content:
                all_chunks.append({
                    "path": current_header or "unknown",
                    "content": f"{current_header}\n{content}",
                    "metadata": {"path": current_header or "unknown"},
                })

    if not all_chunks:
        for path, _ in files[:100]:
            all_chunks.append({
                "path": path,
                "content": f"文件: {path}",
                "metadata": {"path": path},
            })
    return all_chunks
