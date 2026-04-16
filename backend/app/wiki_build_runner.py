from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

from app.content_locale import WikiI18n
from app.wiki_node_build import build_starlight_site, build_vitepress_site

logger = logging.getLogger(__name__)


def build_wiki_site(
    *,
    backend: str,
    project_id: str,
    work_dir: Path,
    site_out: Path,
    site_title: str,
    symbol_nav: list[str],
    wiki_browse_base: str,
    ws: WikiI18n,
) -> None:
    if backend == "mkdocs":
        nav = [
            {ws.mkdocs_nav_home: "index.md"},
            {ws.mkdocs_nav_arch: "architecture.md"},
            {ws.mkdocs_nav_files: "file-index.md"},
        ]
        if len(symbol_nav) == 1:
            nav.append({ws.mkdocs_nav_symbols: symbol_nav[0]})
        else:
            nested = [{ws.mkdocs_nav_part.format(n=i + 1): n} for i, n in enumerate(symbol_nav)]
            nav.append({ws.mkdocs_nav_symbols_multi.format(n=len(symbol_nav)): nested})

        mkdocs_path = work_dir / "mkdocs.yml"
        mk_lang = "zh" if ws.lang == "zh" else "en"
        search_lang = ["zh"] if ws.lang == "zh" else ["en"]
        mkdocs_content: dict[str, Any] = {
            "site_name": site_title,
            "docs_dir": "docs",
            "site_dir": str(site_out.resolve()),
            "theme": {
                "name": "material",
                "language": mk_lang,
                "features": [
                    "navigation.indexes",
                    "navigation.expand",
                    "search.suggest",
                    "search.highlight",
                    "content.code.copy",
                ],
            },
            "markdown_extensions": [
                "attr_list",
                "admonition",
                "pymdownx.details",
                "pymdownx.superfences",
            ],
            "plugins": [
                {"search": {"lang": search_lang}},
            ],
            "nav": nav,
        }
        mkdocs_path.write_text(
            yaml.safe_dump(mkdocs_content, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
        logger.info(
            "Running mkdocs build backend=%s project=%s work_dir=%s",
            backend,
            project_id,
            work_dir,
        )
        proc = subprocess.run(
            [sys.executable, "-m", "mkdocs", "build", "-f", str(mkdocs_path.resolve()), "-q"],
            cwd=str(work_dir),
            capture_output=True,
            text=True,
            timeout=3600,
        )
        if proc.returncode != 0:
            err = (proc.stderr or "") + (proc.stdout or "")
            logger.error("mkdocs build failed: %s", err[-4000:])
            raise RuntimeError(f"mkdocs build failed: {err[-2000:]}")
        return

    if backend == "starlight":
        logger.info(
            "Running Starlight build backend=%s project=%s work_dir=%s",
            backend,
            project_id,
            work_dir,
        )
        build_starlight_site(
            work_dir,
            site_out,
            site_title,
            symbol_nav,
            public_base=wiki_browse_base,
            wiki_ui=ws,
        )
        return

    logger.info(
        "Running VitePress build backend=%s project=%s work_dir=%s",
        backend,
        project_id,
        work_dir,
    )
    build_vitepress_site(
        work_dir,
        site_out,
        site_title,
        symbol_nav,
        public_base=wiki_browse_base,
        wiki_ui=ws,
    )
