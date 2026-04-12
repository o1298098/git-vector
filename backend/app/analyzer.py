import logging
from typing import Any

from app.content_locale import analyze_repo_system_user, describe_batch_system_user
from app.effective_settings import effective_content_language
from app.llm_client import get_llm_client

logger = logging.getLogger(__name__)

# 函数级：每批最多多少个函数发给 LLM 做一行描述
MAX_FUNCS_PER_BATCH = 20
# 每个函数代码截断长度（避免超长）
MAX_CODE_LEN = 4096

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

    lang = effective_content_language()
    system, user_head = describe_batch_system_user(lang)
    tmpl_lbl = "模板" if lang == "zh" else "Template"
    fn_lbl = "函数/方法" if lang == "zh" else "Function/method"
    out: list[dict[str, Any]] = []
    for i in range(0, len(chunks), MAX_FUNCS_PER_BATCH):
        batch = chunks[i : i + MAX_FUNCS_PER_BATCH]
        parts = []
        for j, c in enumerate(batch):
            code = (c.get("code") or "")[:MAX_CODE_LEN]
            kind = c.get("kind") or ""
            label = tmpl_lbl if kind == "vue_template" else fn_lbl
            parts.append(f"[{j}] ({label}) {c.get('path', '')} :: {c.get('name', '')}\n{code}")
        prompt = user_head + "\n\n---\n\n".join(parts)
        try:
            text = client.chat(
                system=system,
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




def analyze_repo_and_describe(
    project_id: str,
    files: list[tuple[str, str]],
) -> list[dict[str, Any]]:
    """对仓库文件分批调用 LLM 生成功能说明，返回用于向量化的文档列表。"""
    client = get_llm_client()
    lang = effective_content_language()
    if not client:
        logger.warning("No LLM client configured, using file names as descriptions")
        tpl = (
            "文件: {p}\n(未配置 LLM，未生成说明)"
            if lang == "zh"
            else "File: {p}\n(LLM not configured; no description)"
        )
        return [{"path": path, "content": tpl.format(p=path), "metadata": {"path": path}} for path, _ in files[:200]]
    all_chunks: list[dict[str, Any]] = []
    batches = _batch_files(files)

    for batch in batches:
        context = _build_file_context(batch)
        system, user = analyze_repo_system_user(lang, project_id, context)
        try:
            text = client.chat(system=system, user=user)
        except Exception as e:
            logger.exception("LLM call failed: %s", e)
            fail_tpl = "文件: {p}\n(分析失败: {err})" if lang == "zh" else "File: {p}\n(Analysis failed: {err})"
            for path, content in batch:
                all_chunks.append({
                    "path": path,
                    "content": fail_tpl.format(p=path, err=e),
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
        stub = "文件: {p}" if lang == "zh" else "File: {p}"
        for path, _ in files[:100]:
            all_chunks.append({
                "path": path,
                "content": stub.format(p=path),
                "metadata": {"path": path},
            })
    return all_chunks
