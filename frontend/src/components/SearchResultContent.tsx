import type { ReactNode } from "react";
// 常用语言合集，避免逐语言注册
import hljs from "highlight.js/lib/common";

function highlightCode(code: string, rawLang: string): { html: string; lang: string } {
  const trimmed = code.replace(/\s+$/, "");
  const lang = rawLang.trim().toLowerCase();
  const aliases: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    yml: "yaml",
    py: "python",
    rb: "ruby",
    rs: "rust",
    kt: "kotlin",
    fs: "fsharp",
  };
  const resolved = lang ? aliases[lang] ?? lang : "plaintext";

  try {
    if (resolved !== "plaintext" && hljs.getLanguage(resolved)) {
      const { value } = hljs.highlight(trimmed, { language: resolved, ignoreIllegals: true });
      return { html: value, lang: resolved };
    }
  } catch {
    /* fall through */
  }

  const auto = hljs.highlightAuto(trimmed);
  return { html: auto.value, lang: auto.language ?? "plaintext" };
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { html, lang: used } = highlightCode(code, lang);
  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-[#f6f8fa] shadow-sm dark:bg-transparent">
      {lang ? (
        <div className="border-b border-border bg-muted/50 px-3 py-1 font-mono text-[11px] text-muted-foreground">{lang}</div>
      ) : null}
      <pre className="m-0 overflow-x-auto bg-transparent p-3">
        <code className={`hljs language-${used}`} dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

export function SearchResultContent({ content }: { content: string }): ReactNode {
  const matches = [...content.matchAll(/```([\w+#.-]{0,32})?\s*\r?\n([\s\S]*?)```/g)];
  if (matches.length === 0) {
    return <div className="whitespace-pre-wrap leading-relaxed text-foreground">{content}</div>;
  }

  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const m of matches) {
    const idx = m.index ?? 0;
    if (idx > last) {
      parts.push(
        <div key={`t-${key++}`} className="whitespace-pre-wrap leading-relaxed text-foreground">
          {content.slice(last, idx)}
        </div>,
      );
    }
    parts.push(<CodeBlock key={`c-${key++}`} code={m[2] ?? ""} lang={(m[1] ?? "").trim()} />);
    last = idx + m[0].length;
  }

  if (last < content.length) {
    parts.push(
      <div key={`t-${key++}`} className="whitespace-pre-wrap leading-relaxed text-foreground">
        {content.slice(last)}
      </div>,
    );
  }

  return <div className="space-y-2">{parts}</div>;
}
