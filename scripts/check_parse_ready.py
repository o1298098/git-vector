#!/usr/bin/env python3
"""
不依赖 tree_sitter，仅检查解析相关代码是否就绪（tsx 回退、variable_declarator 等）。
通过即可放心 docker build；完整解析测试需在容器内运行 scripts/test_parse_local.py。
"""
import os
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
parser_path = os.path.join(root, "app", "code_parser.py")

def main():
    with open(parser_path, "r", encoding="utf-8") as f:
        code = f.read()

    ok = True
    if '"tsx": ["typescript"]' not in code and "'tsx': ['typescript']" not in code:
        print("缺少: tsx -> typescript 的 parser 回退 (_LANG_ALIASES)")
        ok = False
    if "variable_declarator" not in code or "arrow_function" not in code:
        print("缺少: variable_declarator / arrow_function 提取逻辑")
        ok = False
    if "generator_function_declaration" not in code:
        print("缺少: generator_function_declaration 识别")
        ok = False

    if ok:
        print("code_parser 关键修改已就绪，可以 docker build。")
        print("构建后可在容器内运行: docker compose run --rm app python scripts/test_parse_local.py")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
