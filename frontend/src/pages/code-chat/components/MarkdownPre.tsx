import { useCallback, useMemo, useState } from "react";
import type { ComponentProps } from "@ant-design/x-markdown";
import { Check, Code2, Copy } from "lucide-react";
import type { ChildNode } from "domhandler";
import { ElementType } from "domelementtype";
import type { DOMNode, Element as ParserElement } from "html-react-parser";
import { useI18n } from "@/i18n/I18nContext";
import { highlightMarkdownCode } from "@/lib/highlightMarkdownCode";
import { cn } from "@/lib/utils";
import { MermaidDiagram } from "./MermaidDiagram";

/** 从 html-react-parser / domhandler 节点取纯文本（含 CDATA 等子类型） */
function domTextContent(node: ChildNode | undefined | null): string {
  if (!node) return "";
  if (node.type === ElementType.Text || node.type === ElementType.Comment || node.type === ElementType.Directive) {
    return "data" in node ? (node.data ?? "") : "";
  }
  if (
    node.type === ElementType.Tag ||
    node.type === ElementType.Script ||
    node.type === ElementType.Style ||
    node.type === ElementType.Root ||
    node.type === ElementType.CDATA
  ) {
    return node.children?.length ? node.children.map((c) => domTextContent(c)).join("") : "";
  }
  return "";
}

function firstCodeChild(domNode: DOMNode): ParserElement | undefined {
  if (domNode.type !== "tag" || domNode.name !== "pre") return undefined;
  const first = domNode.children?.[0];
  if (first?.type === "tag" && first.name === "code") return first;
  return undefined;
}

type FencedProps = {
  code: string;
  rawLang: string;
  streamStatus: ComponentProps["streamStatus"];
};

function FencedCodeBlock({ code, rawLang, streamStatus }: FencedProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const loading = streamStatus === "loading";
  const primaryLang = (rawLang.trim().split(/\s+/)[0] || "").toLowerCase();
  const isMermaid = primaryLang === "mermaid";

  const { html, lang } = useMemo(() => {
    if (loading || isMermaid) return { html: "", lang: "plaintext" as const };
    return highlightMarkdownCode(code, rawLang);
  }, [code, rawLang, loading, isMermaid]);

  const langLabel = (primaryLang || (lang !== "plaintext" ? lang : "text")).toLowerCase();

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code.replace(/\n$/, ""));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 无剪贴板权限等：静默失败，避免打断阅读 */
    }
  }, [code]);

  const empty = !code.replace(/\n$/, "").trim();

  if (isMermaid) {
    return (
      <div className="gv-xmd-fenced-wrap">
        <div className="gv-xmd-fenced-head">
          <span className="gv-xmd-fenced-lang">
            <Code2 className="gv-xmd-fenced-lang-icon" aria-hidden />
            <span className="min-w-0 truncate">{langLabel}</span>
          </span>
          <button
            type="button"
            className="gv-xmd-fenced-copy"
            disabled={loading || empty}
            aria-label={t("chat.codeCopy")}
            onClick={() => void onCopy()}
          >
            {copied ? (
              <>
                <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <span>{t("chat.copyDone")}</span>
              </>
            ) : (
              <>
                <Copy className="size-4 shrink-0 opacity-80" aria-hidden />
                <span>{t("chat.codeCopy")}</span>
              </>
            )}
          </button>
        </div>
        {loading ? (
          <div className="rounded-b-md border border-t-0 border-black/10 bg-muted/25 px-3 py-6 text-center text-sm text-muted-foreground dark:border-white/10">
            {t("chat.mermaidStreaming")}
          </div>
        ) : (
          <MermaidDiagram code={code} />
        )}
      </div>
    );
  }

  return (
    <div className="gv-xmd-fenced-wrap">
      <div className="gv-xmd-fenced-head">
        <span className="gv-xmd-fenced-lang">
          <Code2 className="gv-xmd-fenced-lang-icon" aria-hidden />
          <span className="min-w-0 truncate">{langLabel}</span>
        </span>
        <button
          type="button"
          className="gv-xmd-fenced-copy"
          disabled={loading || empty}
          aria-label={t("chat.codeCopy")}
          onClick={() => void onCopy()}
        >
          {copied ? (
            <>
              <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span>{t("chat.copyDone")}</span>
            </>
          ) : (
            <>
              <Copy className="size-4 shrink-0 opacity-80" aria-hidden />
              <span>{t("chat.codeCopy")}</span>
            </>
          )}
        </button>
      </div>
      <pre className="gv-xmd-fenced-pre">
        {loading ? (
          <code className="gv-xmd-fenced-code gv-xmd-fenced-code--plain">{code}</code>
        ) : (
          <code
            className={cn("hljs gv-xmd-fenced-code", lang && `language-${lang}`)}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </pre>
    </div>
  );
}

/** 替换 XMarkdown 的 pre：围栏代码块用高亮 + 语言标签 + 复制；其余保持原样 */
export function MarkdownPre(props: ComponentProps) {
  const { domNode, streamStatus, children, className, style } = props;
  const codeEl = firstCodeChild(domNode);
  if (codeEl) {
    const block = codeEl.attribs?.["data-block"];
    if (block === "true") {
      const rawLang = codeEl.attribs?.["data-lang"] ?? "";
      const innerState = codeEl.attribs?.["data-state"];
      const mergedStatus = innerState === "loading" ? "loading" : streamStatus;
      const text = domTextContent(codeEl);
      return (
        <FencedCodeBlock code={text} rawLang={rawLang} streamStatus={mergedStatus ?? "done"} />
      );
    }
  }

  return (
    <pre className={className} style={style}>
      {children}
    </pre>
  );
}
