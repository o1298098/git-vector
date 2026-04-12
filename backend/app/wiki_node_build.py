"""
Starlight / VitePress 静态 Wiki 构建（需本机可用 Node.js + npm；首次会下载依赖）。

由 wiki_generator 在 WIKI_BACKEND=starlight|vitepress 时调用。
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any, Optional

from app.content_locale import WikiI18n, wiki_i18n
from app.effective_settings import effective_npm_registry

logger = logging.getLogger(__name__)


def _normalized_site_base(path: str) -> str:
    """
    FastAPI 将 wiki 挂在 /wiki/<safe_id>/site/（见 app.main mount）。
    Astro/VitePress 默认 base=/，生成的 CSS/JS 会请求 /_astro/... 导致 404、页面无样式。
    """
    p = (path or "/").strip()
    if not p.startswith("/"):
        p = "/" + p
    if len(p) > 1 and not p.endswith("/"):
        p += "/"
    return p


def _npm_subprocess_env() -> dict[str, str]:
    """
    npm 子进程环境：继承当前环境；若 effective_npm_registry() 非空（含界面覆盖），
    则设置 npm_config_registry（与 npm 官方约定一致）。

    未配置 NPM_REGISTRY 时：若环境里只有大写的 NPM_CONFIG_REGISTRY（常见于 Docker Compose），
    会同步为 npm_config_registry，因 npm 只读取后者。
    """
    env = dict(os.environ)
    reg = (effective_npm_registry() or "").strip()
    if reg:
        env["npm_config_registry"] = reg.rstrip("/")
        return env
    if not (env.get("npm_config_registry") or "").strip():
        alt = (env.get("NPM_CONFIG_REGISTRY") or "").strip()
        if alt:
            env["npm_config_registry"] = alt.rstrip("/")
    return env


def node_available() -> bool:
    try:
        r = subprocess.run(
            ["node", "--version"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return r.returncode == 0 and bool((r.stdout or "").strip())
    except Exception:
        return False


def npm_available() -> bool:
    try:
        r = subprocess.run(
            ["npm", "--version"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return r.returncode == 0
    except Exception:
        return False


def _npm_install(work_dir: Path, timeout: int = 900) -> None:
    env = _npm_subprocess_env()
    if env.get("npm_config_registry"):
        logger.info("npm install using registry=%s", env["npm_config_registry"])
    proc = subprocess.run(
        ["npm", "install", "--no-audit", "--no-fund"],
        cwd=str(work_dir),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        err = (proc.stderr or "") + (proc.stdout or "")
        raise RuntimeError(f"npm install 失败: {err[-2500:]}")


def _ensure_starlight_content_layer(work_dir: Path, ws: WikiI18n) -> None:
    """
    Astro 6 + Starlight 0.38 要求显式声明 docs 集合（见 Starlight Manual Setup）。
    缺省时 Astro 会弃用地自动推断 docs，且 Starlight 的 404 路由仍期望集合中存在 id 为 404 的条目；
    缺失时会出现 “Entry docs → 404 was not found”，随后在 Zod 解析阶段触发 _zod 类错误。
    """
    src = work_dir / "src"
    cfg = src / "content.config.ts"
    cfg.write_text(
        """import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
""",
        encoding="utf-8",
    )
    docs = src / "content" / "docs"
    docs.mkdir(parents=True, exist_ok=True)
    # 与 https://starlight.astro.build/guides/customization/#custom-404-page 一致，避免多余嵌套 frontmatter
    # 在个别 Astro/Zod 版本下触发校验边角问题。
    tag_yaml = json.dumps(ws.not_found_tagline, ensure_ascii=False)
    (docs / "404.md").write_text(
        f"""---
title: '404'
template: splash
editUrl: false
hero:
  title: '404'
  tagline: {tag_yaml}
---

""",
        encoding="utf-8",
    )


def _starlight_sidebar(symbol_nav_files: list[str], ws: WikiI18n) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = [
        {"label": ws.nav_home, "link": "/"},
        {"label": ws.nav_architecture, "link": "/architecture"},
        {"label": ws.nav_file_index, "link": "/file-index"},
    ]
    if len(symbol_nav_files) == 1:
        fn = symbol_nav_files[0].replace(".md", "").replace(".MD", "")
        items.append({"label": ws.nav_symbol_index, "link": f"/{fn}"})
    else:
        sym_items = []
        for i, raw in enumerate(symbol_nav_files):
            fn = raw.replace(".md", "").replace(".MD", "")
            label = ws.nav_symbol_index if i == 0 else ws.nav_symbol_index_part.format(n=i + 1)
            sym_items.append({"label": label, "link": f"/{fn}"})
        items.append(
            {"label": ws.nav_symbol_index_multi.format(n=len(symbol_nav_files)), "items": sym_items}
        )
    return items


def _vitepress_sidebar(symbol_nav_files: list[str], ws: WikiI18n) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = [
        {"text": ws.nav_home, "link": "/"},
        {"text": ws.nav_architecture, "link": "/architecture"},
        {"text": ws.nav_file_index, "link": "/file-index"},
    ]
    if len(symbol_nav_files) == 1:
        fn = symbol_nav_files[0].replace(".md", "").replace(".MD", "")
        items.append({"text": ws.nav_symbol_index, "link": f"/{fn}"})
    else:
        sym_items = []
        for i, raw in enumerate(symbol_nav_files):
            fn = raw.replace(".md", "").replace(".MD", "")
            text = ws.nav_symbol_index if i == 0 else ws.nav_symbol_index_part.format(n=i + 1)
            sym_items.append({"text": text, "link": f"/{fn}"})
        items.append(
            {"text": ws.nav_symbol_index_multi.format(n=len(symbol_nav_files)), "items": sym_items}
        )
    return items


def build_starlight_site(
    work_dir: Path,
    site_out: Path,
    site_title: str,
    symbol_nav_files: list[str],
    *,
    public_base: str,
    wiki_ui: Optional[WikiI18n] = None,
) -> None:
    if not node_available() or not npm_available():
        raise RuntimeError("WIKI_BACKEND=starlight 需要可用的 node 与 npm（请安装 Node.js LTS）")
    ws = wiki_ui or wiki_i18n("zh")
    site_out.mkdir(parents=True, exist_ok=True)
    abs_out = str(site_out.resolve())
    base = _normalized_site_base(public_base)
    base_js = json.dumps(base, ensure_ascii=False)
    sidebar = _starlight_sidebar(symbol_nav_files, ws)
    title_js = json.dumps(site_title, ensure_ascii=False)
    out_js = json.dumps(abs_out, ensure_ascii=False)
    sidebar_js = json.dumps(sidebar, ensure_ascii=False)

    astro = f"""// auto-generated by gitlab_vector
import {{ defineConfig }} from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({{
  base: {base_js},
  outDir: {out_js},
  // 自定义 outDir 时，Astro 的 relative 配置 schema 会用 build.client / build.server 的「原始字符串」
  // 相对 outDir 再解析；若未显式传入且 Zod 对空 build 对象未填入嵌套 default，会出现
  // path.resolve(..., undefined) → "paths[1] ... Received undefined"（relative.js）。
  build: {{
    client: "./client/",
    server: "./server/",
  }},
  // validateConfigRefined（refined.js）会遍历 config.image.remotePatterns；若因 Zod 合并顺序
  // 等原因未填入默认 []，会得到 undefined.length。显式写上避免构建失败。
  image: {{
    remotePatterns: [],
  }},
  // 若仍出现多份 zod 导致 _zod 报错，见 https://github.com/withastro/astro/issues/14117
  vite: {{
    resolve: {{ dedupe: ["zod"] }},
    ssr: {{ noExternal: ["zod"] }},
  }},
  integrations: [
    starlight({{
      title: {title_js},
      sidebar: {sidebar_js},
      markdown: {{
        headingLinks: true,
        processedDirs: [],
      }},
    }}),
  ],
}});
"""
    (work_dir / "astro.config.mjs").write_text(astro, encoding="utf-8")
    _ensure_starlight_content_layer(work_dir, ws)
    # 与 Starlight 官方示例一致（见 https://github.com/withastro/starlight/blob/main/examples/basics/package.json ）：
    # Astro 6 + Starlight 0.38；当前 astro@6.0.8 要求 Node ">=22.12.0"（Dockerfile 已用 NodeSource 22.x）。
    # 勿再 npm overrides 锁 zod，易与 Starlight 内部 astro/zod 合并冲突（曾导致 processedDirs / record 校验异常）。
    pkg = {
        "name": "gitlab-vector-wiki",
        "type": "module",
        "private": True,
        "scripts": {"build": "astro build"},
        "dependencies": {
            "astro": "6.0.8",
            "@astrojs/starlight": "0.38.3",
            "sharp": "0.34.2",
        },
    }
    (work_dir / "package.json").write_text(json.dumps(pkg, indent=2), encoding="utf-8")

    logger.info("Starlight: npm install in %s", work_dir)
    _npm_install(work_dir)
    logger.info("Starlight: astro build -> %s", site_out)
    proc = subprocess.run(
        ["npm", "run", "build"],
        cwd=str(work_dir),
        env=_npm_subprocess_env(),
        capture_output=True,
        text=True,
        timeout=3600,
    )
    if proc.returncode != 0:
        err = (proc.stderr or "") + (proc.stdout or "")
        logger.error("astro build failed: %s", err[-4000:])
        raise RuntimeError(f"astro build 失败: {err[-2000:]}")


def build_vitepress_site(
    work_dir: Path,
    site_out: Path,
    site_title: str,
    symbol_nav_files: list[str],
    *,
    public_base: str,
    wiki_ui: Optional[WikiI18n] = None,
) -> None:
    if not node_available() or not npm_available():
        raise RuntimeError("WIKI_BACKEND=vitepress 需要可用的 node 与 npm（请安装 Node.js LTS）")
    ws = wiki_ui or wiki_i18n("zh")
    site_out.mkdir(parents=True, exist_ok=True)
    abs_out = str(site_out.resolve())
    base = _normalized_site_base(public_base)
    sidebar = _vitepress_sidebar(symbol_nav_files, ws)
    vp_lang = "zh-CN" if ws.lang == "zh" else "en-US"
    vp_dir = work_dir / "docs" / ".vitepress"
    vp_dir.mkdir(parents=True, exist_ok=True)

    cfg = f"""// auto-generated by gitlab_vector
import {{ defineConfig }} from "vitepress";

export default defineConfig({{
  title: {json.dumps(site_title, ensure_ascii=False)},
  lang: {json.dumps(vp_lang)},
  base: {json.dumps(base, ensure_ascii=False)},
  outDir: {json.dumps(abs_out)},
  themeConfig: {{
    sidebar: {json.dumps(sidebar, ensure_ascii=False)},
    search: {{
      provider: "local",
    }},
  }},
}});
"""
    (vp_dir / "config.mjs").write_text(cfg, encoding="utf-8")

    pkg = {
        "name": "gitlab-vector-wiki-vp",
        "private": True,
        "type": "module",
        "scripts": {"build": "vitepress build docs"},
        "devDependencies": {
            "vitepress": "^1.5.0",
            "vue": "^3.5.0",
        },
    }
    (work_dir / "package.json").write_text(json.dumps(pkg, indent=2), encoding="utf-8")

    logger.info("VitePress: npm install in %s", work_dir)
    _npm_install(work_dir)
    logger.info("VitePress: vitepress build -> %s", site_out)
    proc = subprocess.run(
        ["npm", "run", "build"],
        cwd=str(work_dir),
        env=_npm_subprocess_env(),
        capture_output=True,
        text=True,
        timeout=3600,
    )
    if proc.returncode != 0:
        err = (proc.stderr or "") + (proc.stdout or "")
        logger.error("vitepress build failed: %s", err[-4000:])
        raise RuntimeError(f"vitepress build 失败: {err[-2000:]}")
