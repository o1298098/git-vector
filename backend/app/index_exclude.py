"""
索引时按用户配置的 glob 排除仓库内源码路径（相对仓库根，POSIX 风格）。

规则见 README / 设置页说明；与内置 SKIP_PATTERNS（目录名等）叠加生效。
"""

from __future__ import annotations

import logging
from pathlib import PurePosixPath

logger = logging.getLogger(__name__)

MAX_RAW_BYTES = 64_000
MAX_PATTERNS = 200


def split_pattern_lines(raw: str) -> list[str]:
    """
    拆成若干条原始模式：
    - 含换行：每行一条（# 开头为注释）；行内不再按逗号拆，避免路径里含逗号歧义。
    - 单行：可按英文逗号分隔多条（便于 .env 一行书写）。
    """
    s = (raw or "").strip()
    if not s:
        return []
    if "\n" in s or "\r" in s:
        out: list[str] = []
        for line in s.replace("\r\n", "\n").split("\n"):
            line = line.strip()
            if line and not line.startswith("#"):
                out.append(line)
        return out
    return [p.strip() for p in s.split(",") if p.strip() and not p.strip().startswith("#")]


def normalize_user_glob(pattern: str) -> str:
    """ pathlib.PurePosixPath.match 语义下，目录树 `foo/**` 需写成 `foo/**/*` 才能匹配子路径。 """
    p = pattern.strip()
    if not p:
        return ""
    if p.endswith("/**") and not p.endswith("/**/*"):
        return p + "/*"
    return p


def parse_index_exclude_patterns(raw: str) -> list[str]:
    if not raw:
        return []
    if len(raw) > MAX_RAW_BYTES:
        logger.warning("index_exclude_patterns truncated from %s to %s bytes", len(raw), MAX_RAW_BYTES)
        raw = raw[:MAX_RAW_BYTES]
    seen: set[str] = set()
    out: list[str] = []
    for line in split_pattern_lines(raw):
        ng = normalize_user_glob(line)
        if not ng or ng in seen:
            continue
        seen.add(ng)
        out.append(ng)
        if len(out) >= MAX_PATTERNS:
            logger.warning("index_exclude_patterns: at most %s patterns kept", MAX_PATTERNS)
            break
    return out


def rel_path_posix(rel: str) -> str:
    """统一为相对仓库、正斜杠、无开头 ./ """
    s = str(rel).replace("\\", "/").strip()
    while s.startswith("./"):
        s = s[2:]
    return s.lstrip("/")


def path_matches_index_exclude(rel_path: str, normalized_patterns: list[str]) -> bool:
    if not normalized_patterns:
        return False
    posix = rel_path_posix(rel_path)
    if not posix:
        return False
    pp = PurePosixPath(posix)
    for pat in normalized_patterns:
        try:
            if pp.match(pat):
                return True
        except Exception as e:  # noqa: BLE001
            logger.debug("Invalid index exclude glob %r: %s", pat, e)
            continue
    return False
