import { Sources } from "@ant-design/x";
import XMarkdown from "@ant-design/x-markdown";
import type { StoredHit as Hit } from "@/lib/codeChatStorage";
import { useI18n } from "@/i18n/I18nContext";
import { formatMetaLine } from "./formatMetaLine";
import { MarkdownPre } from "./MarkdownPre";

type Props = {
  full: string;
  sources?: Hit[];
  retrievalQuery?: string;
  resolvedDark: boolean;
  isStreaming?: boolean;
};

/** 助手 Markdown：流式时 XMarkdown 尾部光标；结束后展示检索用语与引用 */
export function AssistantMarkdownBubble({ full, sources, retrievalQuery, resolvedDark, isStreaming }: Props) {
  const { t } = useI18n();
  const streaming = Boolean(isStreaming);

  return (
    <div className={resolvedDark ? "x-markdown-dark" : "x-markdown-light"}>
      <XMarkdown
        content={full}
        components={{ pre: MarkdownPre }}
        streaming={
          streaming
            ? {
                hasNextChunk: true,
                tail: true,
              }
            : undefined
        }
      />
      {!streaming && retrievalQuery ? (
        <div className="mt-2 border-t border-dashed border-black/10 pt-2 text-xs text-black/55 dark:border-white/15 dark:text-white/55">
          {t("chat.retrievalQueryHint", { q: retrievalQuery })}
        </div>
      ) : null}
      {!streaming && sources && sources.length > 0 ? (
        <Sources
          style={{ marginTop: 12 }}
          title={t("chat.sourcesTitle", { n: sources.length })}
          items={sources.map((hit, j) => {
            const meta = hit.metadata ?? {};
            const line = formatMetaLine(meta, t("search.lines"));
            const desc = (hit.content || "").replace(/\s+/g, " ").trim();
            return {
              key: j,
              title: line ?? t("search.hitRank", { i: j + 1 }),
              description: desc.length > 240 ? `${desc.slice(0, 240)}…` : desc,
            };
          })}
          defaultExpanded={false}
        />
      ) : null}
    </div>
  );
}
