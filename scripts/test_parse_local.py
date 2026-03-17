#!/usr/bin/env python3
"""
不克隆仓库，仅用内联 TS/TSX 代码测试函数级解析是否正常。
无需网络与 git，用于在 docker build 前确认解析逻辑无误。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 内联 TSX 示例：包含 function、const X = () => {}、class
SAMPLE_TSX = """
export const LoginForm = () => {
  const [loading, setLoading] = useState(false);
  return <Form onFinish={handleSubmit} />;
};

function useAuth() {
  return { user: null };
}

export default function App() {
  return <div>Hello</div>;
}
"""

SAMPLE_TS = """
export function getDeviceList(): Promise<Device[]> {
  return api.get('/devices');
}

const formatDate = (d: Date) => d.toISOString();
"""


def main():
    from app.code_parser import parse_file, _get_parser, parse_files

    print("=== 本地解析测试（无需 clone）===")
    print("1. Parser: tsx=%s, typescript=%s" % (
        "OK" if _get_parser("tsx") else "None",
        "OK" if _get_parser("typescript") else "None",
    ))

    if not _get_parser("tsx") and not _get_parser("typescript"):
        print("失败: 无 TS/TSX parser，请安装 tree-sitter-languages 并确认支持 typescript")
        return 1

    print("2. 解析内联 TSX 片段...")
    chunks_tsx = parse_file("sample.tsx", SAMPLE_TSX)
    print("   sample.tsx -> %d chunks" % len(chunks_tsx))
    for c in chunks_tsx:
        print("     - %s (kind=%s)" % (c.get("name"), c.get("kind")))

    print("3. 解析内联 TS 片段...")
    chunks_ts = parse_file("sample.ts", SAMPLE_TS)
    print("   sample.ts -> %d chunks" % len(chunks_ts))
    for c in chunks_ts:
        print("     - %s (kind=%s)" % (c.get("name"), c.get("kind")))

    total = len(chunks_tsx) + len(chunks_ts)
    if total == 0:
        print("失败: 未解析出任何函数（parser 有但节点类型可能不匹配）")
        return 1
    print("4. 合计 %d 个 chunk，解析逻辑正常。" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
