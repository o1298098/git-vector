#!/usr/bin/env python3
"""
测试 iot-frontend 仓库能否解析出函数级 chunk。
用法（项目根目录）：python scripts/test_parse_iot.py
私有仓库时需在 .env 中配置 GITLAB_ACCESS_TOKEN 或 GIT_HTTPS_TOKEN。
"""
import logging
import os
import sys
# 本地：仓库根/backend；容器内：WORKDIR 为含 app 包的目录（如 /app）
_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _base in (os.path.join(_root, "backend"), _root):
    if os.path.isfile(os.path.join(_base, "app", "__init__.py")):
        sys.path.insert(0, _base)
        break
else:
    sys.path.insert(0, os.path.join(_root, "backend"))

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

RESULT_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "test_parse_result.txt")

REPO_URL = "https://gitlab.o1298098.xyz/o1298098/iot-frontend.git"
PROJECT_ID = "o1298098/iot-frontend"


def main():
    from app.indexer import clone_or_pull, collect_code_files, _repo_dir
    from app.code_parser import parse_files, _get_parser
    from app.job_queue import build_repo_url_for_clone

    repo_url = build_repo_url_for_clone(REPO_URL)

    if os.environ.get("SKIP_CLONE") == "1":
        repo_path = _repo_dir(PROJECT_ID)
        if not repo_path.exists():
            print("SKIP_CLONE=1 但本地无仓库: %s" % repo_path)
            return 1
        print("1. 使用已有仓库 (SKIP_CLONE=1): %s" % repo_path)
    else:
        print("1. 克隆/拉取仓库...")
        try:
            repo_path = clone_or_pull(repo_url, PROJECT_ID)
        except Exception as e:
            msg = "克隆失败: %s\n若为私有仓库，请在 .env 中配置 GITLAB_ACCESS_TOKEN" % e
            print("   " + msg.replace("\n", "\n   "))
            try:
                with open(RESULT_FILE, "w", encoding="utf-8") as f:
                    f.write("clone_failed=%s\n" % str(e))
            except Exception:
                pass
            return 1

    print("2. 收集代码文件...")
    files = collect_code_files(repo_path)
    exts = {}
    for path, _ in files:
        ext = (path.rsplit(".", 1)[-1] if "." in path else "no_ext").lower()
        exts[ext] = exts.get(ext, 0) + 1
    print(f"   共 {len(files)} 个文件, 扩展名统计: {exts}")

    print("3. Parser 可用性: tsx=%s, typescript=%s" % ("OK" if _get_parser("tsx") else "None", "OK" if _get_parser("typescript") else "None"))

    print("4. 函数级解析...")
    chunks = parse_files(files)
    print(f"   得到 {len(chunks)} 个函数/方法级 chunk")

    lines = []
    if chunks:
        print("5. 前 10 条 chunk 示例:")
        for i, c in enumerate(chunks[:10]):
            line = "   [%d] %s | %s (kind=%s) L%s-%s" % (i+1, c.get("path", ""), c.get("name", ""), c.get("kind", ""), c.get("start_line", 0), c.get("end_line", 0))
            print(line)
            lines.append(line)
    else:
        msg = "5. 无函数级 chunk，当前会使用 file-level fallback。请查看上方 Parser 是否为 OK。"
        print(msg)
        lines.append(msg)

    try:
        with open(RESULT_FILE, "w", encoding="utf-8") as f:
            f.write("files=%s chunks=%s parser_tsx=%s parser_ts=%s\n" % (len(files), len(chunks), "OK" if _get_parser("tsx") else "None", "OK" if _get_parser("typescript") else "None"))
            f.write("\n".join(lines))
        print("结果已写入 %s" % RESULT_FILE)
    except Exception as e:
        print("写结果文件失败:", e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
