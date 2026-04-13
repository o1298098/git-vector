"""
管理端：数据目录磁盘用量与本地 Git 缓存概况（只读）。
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.auth_ui import require_ui_session
from app.config import settings
from app.ui_overrides import overrides_path

router = APIRouter()


def _path_size_bytes(path: Path) -> int:
    """文件或目录占用字节数（目录递归；不存在返回 0）。"""
    if not path.exists():
        return 0
    try:
        if path.is_file() or (path.is_symlink() and not path.is_dir()):
            return int(path.stat().st_size)
    except OSError:
        return 0
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for name in files:
                fp = Path(root) / name
                try:
                    total += int(fp.stat().st_size)
                except OSError:
                    continue
    except OSError:
        return total
    return total


class StorageVolume(BaseModel):
    total_bytes: int
    free_bytes: int
    used_bytes: int


class StorageBreakdownItem(BaseModel):
    key: str
    path: str
    size_bytes: int
    exists: bool


class RepoCacheInfo(BaseModel):
    max_gb: float
    max_count: int
    cached_repo_dirs: int


class StorageSummary(BaseModel):
    vector_store_bytes: int
    repo_mirrors_bytes: int
    wiki_sites_bytes: int


class AdminStorageResponse(BaseModel):
    data_dir: str
    volume: StorageVolume
    breakdown: list[StorageBreakdownItem]
    other_bytes: int
    data_dir_total_bytes: int
    repo_cache: RepoCacheInfo
    summary: StorageSummary


def _breakdown_item(key: str, path: Path) -> StorageBreakdownItem:
    exists = path.exists()
    return StorageBreakdownItem(key=key, path=str(path.resolve()), size_bytes=_path_size_bytes(path), exists=exists)


@router.get("/admin/storage", response_model=AdminStorageResponse)
def get_admin_storage(_user: Annotated[Optional[str], Depends(require_ui_session)]):
    data = settings.data_path.resolve()
    data.mkdir(parents=True, exist_ok=True)

    usage = shutil.disk_usage(data)
    vol = StorageVolume(
        total_bytes=int(usage.total),
        free_bytes=int(usage.free),
        used_bytes=int(usage.total - usage.free),
    )

    known: list[tuple[str, Path]] = [
        ("repos", settings.repos_path),
        ("chroma", settings.chroma_path),
        ("wiki_sites", data / "wiki_sites"),
        ("wiki_work", data / "wiki_work"),
        ("index_jobs", data / "index_jobs.sqlite3"),
        ("project_index", data / "project_index.sqlite3"),
        ("llm_usage", data / "llm_usage.sqlite3"),
        ("ui_overrides", overrides_path()),
    ]
    known_names = {name for name, _p in known}
    breakdown = [_breakdown_item(k, p) for k, p in known]
    by_key = {x.key: x.size_bytes for x in breakdown}

    other = 0
    try:
        for child in data.iterdir():
            if child.name in known_names:
                continue
            other += _path_size_bytes(child)
    except OSError:
        other = 0

    data_total = sum(x.size_bytes for x in breakdown) + int(other)

    repos_root = settings.repos_path
    try:
        n_repos = sum(1 for p in repos_root.iterdir() if p.is_dir()) if repos_root.exists() else 0
    except OSError:
        n_repos = 0

    return AdminStorageResponse(
        data_dir=str(data),
        volume=vol,
        breakdown=breakdown,
        other_bytes=int(other),
        data_dir_total_bytes=int(data_total),
        repo_cache=RepoCacheInfo(
            max_gb=float(settings.repos_cache_max_gb or 0),
            max_count=int(settings.repos_cache_max_count or 0),
            cached_repo_dirs=int(n_repos),
        ),
        summary=StorageSummary(
            vector_store_bytes=int(by_key.get("chroma", 0)),
            repo_mirrors_bytes=int(by_key.get("repos", 0)),
            wiki_sites_bytes=int(by_key.get("wiki_sites", 0)),
        ),
    )
