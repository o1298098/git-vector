import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageCircle } from "lucide-react";
import type { BubbleItemType, BubbleListProps } from "@ant-design/x";
import { Bubble, Sender, Sources, XProvider } from "@ant-design/x";
import XMarkdown from "@ant-design/x-markdown";
import "@ant-design/x-markdown/themes/light.css";
import "@ant-design/x-markdown/themes/dark.css";
import enUS_X from "@ant-design/x/locale/en_US";
import zhCN_X from "@ant-design/x/locale/zh_CN";
import { Button, theme } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { apiFetch, apiJson } from "@/lib/api";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SearchableProjectSelect } from "@/components/SearchableProjectSelect";
import { useI18n } from "@/i18n/I18nContext";
import { useTheme } from "@/theme/ThemeContext";

type Hit = {
  score?: number | null;
  distance?: number | null;
  content: string;
  metadata?: Record<string, unknown>;
};

type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Hit[];
  /** 后端 LLM 改写后用于向量检索的语句 */
  retrievalQuery?: string;
  /** 模型回复是否仍在流式输出 */
  streaming?: boolean;
};

type ProjectOption = { project_id: string; project_name?: string | null };

/**
 * 与 shadcn 主题变量对齐的气泡样式。
 * 使用 variant=borderless，避免与 body 上的边框/背景叠成「双层卡片」；
 * maxWidth 放在 body 上，避免 content 变窄而 body 仍撑满一行产生大块空白边框感。
 */
const CODE_CHAT_BUBBLE_ROLE: NonNullable<BubbleListProps["role"]> = {
  user: {
    placement: "end",
    variant: "borderless",
    shape: "corner",
    styles: {
      body: {
        maxWidth: "min(100%, 28rem)",
        borderRadius: "14px 18px 6px 14px",
        background: "hsl(var(--primary) / 0.16)",
        border: "1px solid hsl(var(--primary) / 0.28)",
        boxShadow: "0 2px 12px hsl(var(--primary) / 0.14)",
        paddingInline: 14,
        paddingBlock: 10,
        boxSizing: "border-box",
      },
      content: {
        maxWidth: "100%",
        fontSize: 14,
        lineHeight: 1.65,
        color: "hsl(var(--foreground))",
      },
    },
  },
  ai: {
    placement: "start",
    variant: "borderless",
    shape: "corner",
    styles: {
      body: {
        maxWidth: "min(100%, 40rem)",
        borderRadius: "18px 14px 14px 8px",
        background: "hsl(var(--card))",
        border: "1px solid hsl(var(--border))",
        boxShadow: "0 1px 4px hsl(var(--foreground) / 0.06)",
        paddingInline: 14,
        paddingBlock: 10,
        boxSizing: "border-box",
      },
      content: {
        maxWidth: "100%",
        fontSize: 14,
        lineHeight: 1.65,
        color: "hsl(var(--foreground))",
      },
    },
  },
};

function formatMetaLine(meta: Record<string, unknown>, linesLabel: string): string | null {
  const path = meta.path ?? meta.file;
  const name = meta.name;
  const sl = meta.start_line;
  const el = meta.end_line;
  const parts: string[] = [];
  if (path != null && String(path)) parts.push(String(path));
  if (name != null && String(name)) parts.push(String(name));
  if (sl != null || el != null) {
    parts.push(`${linesLabel} ${sl ?? "?"}-${el ?? sl ?? "?"}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

/** 助手 Markdown：流式时 XMarkdown 尾部光标；结束后展示检索用语与引用 */
function AssistantMarkdownBubble({
  full,
  sources,
  retrievalQuery,
  resolvedDark,
  isStreaming,
}: {
  full: string;
  sources?: Hit[];
  retrievalQuery?: string;
  resolvedDark: boolean;
  isStreaming?: boolean;
}) {
  const { t } = useI18n();
  const streaming = Boolean(isStreaming);

  return (
    <div className={resolvedDark ? "x-markdown-dark" : "x-markdown-light"}>
      <XMarkdown
        content={full}
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

export function CodeChat() {
  const { t, locale: uiLocale } = useI18n();
  const { resolvedDark } = useTheme();
  const [projectId, setProjectId] = useState("");
  const [topK, setTopK] = useState(12);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);

  const mergedLocale = useMemo(
    () => (uiLocale === "zh" ? { ...zhCN, ...zhCN_X } : { ...enUS, ...enUS_X }),
    [uiLocale],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiJson<{ projects: ProjectOption[] }>("/api/projects");
        if (!cancelled) setProjects(data.projects ?? []);
      } catch {
        if (!cancelled) setProjects([]);
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const doSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;
      const uid = crypto.randomUUID();
      const aid = crypto.randomUUID();
      setTurns((prev) => [...prev, { id: uid, role: "user", content: trimmed }]);
      setLoading(true);
      const body = JSON.stringify({
        message: trimmed,
        project_id: projectId.trim() || null,
        top_k: topK,
      });
      try {
        const res = await apiFetch("/api/code-chat/stream", {
          method: "POST",
          body,
        });
        if (!res.ok) {
          let detail = res.statusText;
          try {
            const j = await res.json();
            if (j?.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
          } catch {
            /* ignore */
          }
          setTurns((prev) => [
            ...prev,
            {
              id: aid,
              role: "assistant",
              content: t("chat.errorBubble", { detail }),
            },
          ]);
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          setTurns((prev) => [
            ...prev,
            {
              id: aid,
              role: "assistant",
              content: t("chat.errorBubble", { detail: "No response body" }),
            },
          ]);
          return;
        }
        const dec = new TextDecoder();
        let buf = "";
        let metaReceived = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (;;) {
            const sep = buf.indexOf("\n\n");
            if (sep < 0) break;
            const block = buf.slice(0, sep).trim();
            buf = buf.slice(sep + 2);
            if (!block.startsWith("data:")) continue;
            const raw = block.slice(5).trim();
            let data: {
              event?: string;
              text?: string;
              retrieval_query?: string;
              sources?: Hit[];
              message?: string;
            };
            try {
              data = JSON.parse(raw) as typeof data;
            } catch {
              continue;
            }
            const ev = data.event;
            if (ev === "meta") {
              if (!metaReceived) {
                metaReceived = true;
                setLoading(false);
                setTurns((prev) => [
                  ...prev,
                  {
                    id: aid,
                    role: "assistant",
                    content: "",
                    sources: data.sources ?? [],
                    retrievalQuery: data.retrieval_query,
                    streaming: true,
                  },
                ]);
              }
            } else if (ev === "delta" && data.text) {
              if (!metaReceived) {
                metaReceived = true;
                setLoading(false);
                setTurns((prev) => [
                  ...prev,
                  {
                    id: aid,
                    role: "assistant",
                    content: data.text ?? "",
                    streaming: true,
                  },
                ]);
              } else {
                setTurns((prev) =>
                  prev.map((x) => (x.id === aid ? { ...x, content: x.content + data.text! } : x)),
                );
              }
            } else if (ev === "done") {
              setTurns((prev) =>
                prev.map((x) => (x.id === aid ? { ...x, streaming: false } : x)),
              );
            } else if (ev === "error") {
              const errText = data.message ?? t("chat.sendFail");
              setLoading(false);
              if (!metaReceived) {
                metaReceived = true;
                setTurns((prev) => [
                  ...prev,
                  { id: aid, role: "assistant", content: errText, streaming: false },
                ]);
              } else {
                setTurns((prev) =>
                  prev.map((x) =>
                    x.id === aid
                      ? { ...x, content: x.content || errText, streaming: false }
                      : x,
                  ),
                );
              }
            }
          }
        }
        if (!metaReceived) {
          setTurns((prev) => [
            ...prev,
            {
              id: aid,
              role: "assistant",
              content: t("chat.streamAborted"),
              streaming: false,
            },
          ]);
        } else {
          setTurns((prev) =>
            prev.map((x) => (x.id === aid && x.streaming ? { ...x, streaming: false } : x)),
          );
        }
      } catch (e: unknown) {
        setTurns((prev) => [
          ...prev,
          {
            id: aid,
            role: "assistant",
            content: t("chat.errorBubble", { detail: e instanceof Error ? e.message : t("chat.sendFail") }),
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [loading, projectId, topK, t],
  );

  const bubbleItems: BubbleItemType[] = useMemo(() => {
    const items: BubbleItemType[] = turns.map((turn) => {
      if (turn.role === "user") {
        return { key: turn.id, role: "user", content: turn.content };
      }
      return {
        key: turn.id,
        role: "ai",
        content: (
          <AssistantMarkdownBubble
            full={turn.content}
            sources={turn.sources}
            retrievalQuery={turn.retrievalQuery}
            resolvedDark={resolvedDark}
            isStreaming={turn.streaming === true}
          />
        ),
      };
    });
    if (loading) {
      items.push({ key: "__loading__", role: "ai", loading: true, content: "" });
    }
    return items;
  }, [turns, loading, resolvedDark]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("chat.title")}</h1>
        <p className="text-muted-foreground">{t("chat.subtitle")}</p>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
        <aside className="w-full shrink-0 space-y-4 lg:w-80" aria-label={t("chat.sidebarAria")}>
          <div className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
            <div className="mb-1 font-semibold leading-none tracking-tight">{t("chat.contextTitle")}</div>
            <p className="mb-4 text-sm text-muted-foreground">{t("chat.contextDesc")}</p>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t("search.projectLabel")}</Label>
                <SearchableProjectSelect
                  projects={projects}
                  loading={projectsLoading}
                  value={projectId}
                  onChange={setProjectId}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="chat-topk">{t("search.topKLabel")}</Label>
                <Input
                  id="chat-topk"
                  type="number"
                  min={1}
                  max={30}
                  value={topK}
                  onChange={(e) => setTopK(Math.min(30, Math.max(1, Number(e.target.value) || 12)))}
                />
                <p className="text-xs text-muted-foreground">{t("chat.topKHint")}</p>
              </div>
            </div>
          </div>
        </aside>

        <div className="min-h-0 min-w-0 flex-1">
          <XProvider
            locale={mergedLocale}
            theme={{
              algorithm: resolvedDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
            }}
          >
            <div
              className="flex h-[min(70vh,640px)] min-h-[260px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm"
              style={{ display: "flex", flexDirection: "column" }}
            >
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
              <MessageCircle className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium">{t("chat.threadTitle")}</span>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
              {turns.length === 0 && !loading ? (
                <p className="shrink-0 px-1 py-4 text-sm text-muted-foreground">{t("chat.emptyHint")}</p>
              ) : null}
              <Bubble.List
                rootClassName="gv-code-chat-bubbles"
                items={bubbleItems}
                autoScroll
                role={CODE_CHAT_BUBBLE_ROLE}
                styles={{
                  scroll: {
                    flex: 1,
                    minHeight: 0,
                    maxHeight: "100%",
                    overflowY: "auto",
                    paddingInline: 6,
                    paddingBlock: 4,
                  },
                }}
              />
            </div>

            <div className="shrink-0 space-y-2 border-t border-border p-3">
              <Sender
                value={input}
                onChange={(v) => setInput(v)}
                onSubmit={(msg) => {
                  setInput("");
                  void doSend(msg);
                }}
                submitType="enter"
                loading={loading}
                placeholder={t("chat.inputPh")}
                autoSize={{ minRows: 2, maxRows: 6 }}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{t("chat.sendShortcut")}</span>
                <Button size="small" disabled={loading} onClick={() => setTurns([])}>
                  {t("chat.clear")}
                </Button>
              </div>
            </div>
            </div>
          </XProvider>
        </div>
      </div>
    </div>
  );
}
