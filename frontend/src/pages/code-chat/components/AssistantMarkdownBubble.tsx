import { Sources } from "@ant-design/x";
import XMarkdown from "@ant-design/x-markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "antd";
import { X } from "lucide-react";
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

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function withBasePath(path: string): string {
  const baseUrl = typeof import.meta.env.BASE_URL === "string" ? import.meta.env.BASE_URL : "/";
  const base = baseUrl.replace(/\/+$/, "");
  if (!base || base === "/") return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function buildHitUrl(hit: Hit, retrievalQuery?: string): string | undefined {
  const meta = hit.metadata ?? {};
  const projectId = asString(meta.project_id);
  const path = asString(meta.path) || asString(meta.file);
  const symbol = asString(meta.name);
  const q = path || symbol || asString(retrievalQuery);
  if (!projectId && !q) return undefined;
  const params = new URLSearchParams();
  if (projectId) params.set("project_id", projectId);
  if (q) params.set("q", q);
  return `${withBasePath("/vectors")}?${params.toString()}`;
}

/** 助手 Markdown：流式时 XMarkdown 尾部光标；结束后展示检索用语与引用 */
export function AssistantMarkdownBubble({ full, sources, retrievalQuery, resolvedDark, isStreaming }: Props) {
  const { t } = useI18n();
  const streaming = Boolean(isStreaming);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previewHit = previewIndex == null ? null : (sources?.[previewIndex] ?? null);
  const previewMeta = useMemo(() => {
    if (!previewHit?.metadata || typeof previewHit.metadata !== "object") return {};
    return previewHit.metadata;
  }, [previewHit]);
  const previewTitle = useMemo(() => {
    if (!previewHit) return "";
    const line = formatMetaLine(previewMeta, t("search.lines"));
    return line ?? t("search.hitRank", { i: String((previewIndex ?? 0) + 1) });
  }, [previewHit, previewMeta, t, previewIndex]);
  const previewUrl = useMemo(() => {
    if (!previewHit) return undefined;
    return buildHitUrl(previewHit, retrievalQuery);
  }, [previewHit, retrievalQuery]);

  useEffect(() => {
    if (previewHit == null) return;
    function onPointerDown(ev: MouseEvent) {
      const panel = panelRef.current;
      if (!panel) return;
      const target = ev.target as Node | null;
      if (target && panel.contains(target)) return;
      setPreviewIndex(null);
    }
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [previewHit]);

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
          onClick={(item) => {
            const idx = typeof item.key === "number" ? item.key : Number(item.key);
            if (Number.isFinite(idx) && idx >= 0) setPreviewIndex(idx);
          }}
          defaultExpanded={false}
        />
      ) : null}
      {previewHit ? (
        <div
          ref={panelRef}
          className="fixed inset-x-2 bottom-2 top-16 z-[70] overflow-hidden rounded-xl border bg-background shadow-xl md:inset-auto md:right-6 md:top-20 md:w-[520px] md:max-h-[86vh]"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">{t("chat.sourcePreviewTitle")}</span>
            <div className="flex items-center gap-2">
              {previewUrl ? (
                <Button type="link" href={previewUrl} target="_blank" rel="noreferrer" className="px-0">
                  {t("chat.sourcePreviewOpen")}
                </Button>
              ) : null}
              <button
                type="button"
                onClick={() => setPreviewIndex(null)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("chat.editCancel")}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="flex min-h-0 h-[calc(100%-2.5rem)] flex-col p-3 md:h-auto">
            <div className="space-y-3 min-h-0 flex-1">
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium">{previewTitle}</div>
              <div className="h-full min-h-0 overflow-auto rounded-xl border bg-background p-3 md:h-[500px]">
                <div className={`gv-code-chat-bubbles ${resolvedDark ? "x-markdown-dark" : "x-markdown-light"}`}>
                  <XMarkdown content={previewHit.content || ""} components={{ pre: MarkdownPre }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
