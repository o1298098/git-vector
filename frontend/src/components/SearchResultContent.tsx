import type { ReactNode } from "react";
import { highlightMarkdownCode } from "@/lib/highlightMarkdownCode";

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { html, lang: used } = highlightMarkdownCode(code, lang);
  return (
    <div className="gv-embed-codeblock my-2 overflow-hidden rounded-md border border-border bg-[#fafafa] shadow-sm dark:border-border dark:bg-muted">
      {lang ? (
        <div className="border-b border-border bg-muted/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {lang}
        </div>
      ) : null}
      <pre className="gv-embed-codeblock-pre m-0 w-full max-w-full overflow-x-auto bg-transparent">
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
