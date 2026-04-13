import { useEffect, useMemo, useState } from "react";
import { Bubble, Sender, XProvider } from "@ant-design/x";
import "@ant-design/x-markdown/themes/light.css";
import "@ant-design/x-markdown/themes/dark.css";
import enUS_X from "@ant-design/x/locale/en_US";
import zhCN_X from "@ant-design/x/locale/zh_CN";
import { Button, theme } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { X } from "lucide-react";
import { useI18n } from "@/i18n/I18nContext";
import { useTheme } from "@/theme/ThemeContext";
import { CODE_CHAT_BUBBLE_ROLE } from "./components/codeChatBubbleRole";
import { CodeChatHistoryCard } from "./components/CodeChatHistoryCard";
import { CodeChatComposerPrefix } from "./components/CodeChatSessionToolbar";
import { useCodeChat } from "./components/useCodeChat";
import { useCodeChatBubbleItems } from "./components/useCodeChatBubbleItems";

export function CodeChat() {
  const { t, locale: uiLocale } = useI18n();
  const { resolvedDark } = useTheme();
  const chat = useCodeChat();
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);

  const mergedLocale = useMemo(
    () => (uiLocale === "zh" ? { ...zhCN, ...zhCN_X } : { ...enUS, ...enUS_X }),
    [uiLocale],
  );

  const inputPlaceholder = useMemo(() => {
    const pid = chat.projectId.trim();
    if (!pid) return t("chat.inputPhAllProjects");
    const p = chat.projects.find((x) => x.project_id === pid);
    const name = p?.project_name?.trim();
    const label = name || pid;
    return t("chat.inputPhForProject", { project: label });
  }, [chat.projectId, chat.projects, t]);

  const bubbleItems = useCodeChatBubbleItems({
    turns: chat.turns,
    loading: chat.loading,
    resolvedDark,
    editingUserId: chat.editingUserId,
    setEditingUserId: chat.setEditingUserId,
    handleUserEditConfirm: chat.handleUserEditConfirm,
    handleRetryAssistant: chat.handleRetryAssistant,
  });

  useEffect(() => {
    if (!mobileHistoryOpen) return;
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMobileHistoryOpen(false);
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileHistoryOpen]);

  const handleHistoryNewChat = () => {
    chat.newChat();
    setMobileHistoryOpen(false);
  };

  const handleHistorySelectSession = (id: string) => {
    chat.selectSession(id);
    setMobileHistoryOpen(false);
  };

  const handleHistoryDeleteSession = (id: string) => {
    chat.deleteSession(id);
    setMobileHistoryOpen(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden lg:flex-row lg:items-stretch lg:min-h-0">
      <aside
        className="order-2 hidden min-h-[120px] max-h-[32vh] w-full shrink-0 flex-col border-t border-border bg-muted/55 dark:border-border dark:bg-muted/30 lg:order-none lg:flex lg:h-auto lg:max-h-none lg:min-h-0 lg:w-[14rem] lg:shrink-0 lg:self-stretch lg:border-t-0 lg:border-r"
        aria-label={t("chat.sidebarAria")}
      >
        <CodeChatHistoryCard
          sortedSessions={chat.sortedSessions}
          activeId={chat.activeId}
          loading={chat.loading}
          onNewChat={handleHistoryNewChat}
          onSelectSession={handleHistorySelectSession}
          onDeleteSession={handleHistoryDeleteSession}
        />
      </aside>

      <div className="order-1 flex min-h-0 min-w-0 flex-1 flex-col lg:order-none">
        <XProvider
          locale={mergedLocale}
          theme={{
            algorithm: resolvedDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
          }}
        >
          <div
            className="gv-code-chat-main flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
            style={{ display: "flex", flexDirection: "column" }}
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="gv-code-chat-thread mx-auto flex min-h-0 w-full flex-1 flex-col px-3 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-6">
                {chat.turns.length === 0 && !chat.loading ? (
                  <p className="mx-auto max-w-md shrink-0 px-2 py-12 text-center text-[15px] leading-relaxed text-muted-foreground sm:py-16">
                    {t("chat.emptyHint")}
                  </p>
                ) : null}
                <Bubble.List
                  rootClassName="gv-code-chat-bubbles min-h-0 flex-1"
                  items={bubbleItems}
                  autoScroll
                  role={CODE_CHAT_BUBBLE_ROLE}
                  styles={{
                    scroll: {
                      flex: 1,
                      minHeight: 0,
                      maxHeight: "100%",
                      overflowY: "auto",
                      paddingInline: 2,
                      paddingBlock: 4,
                    },
                  }}
                />
              </div>
            </div>

            <div className="gv-code-chat-dock shrink-0 border-t border-border/40 bg-background/85 px-3 py-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 sm:px-6 sm:py-4">
              <div className="gv-code-chat-thread mx-auto w-full">
                <Sender
                  rootClassName="gv-code-chat-sender"
                  styles={{
                    root: {
                      borderRadius: 28,
                      borderColor: resolvedDark ? "hsl(0 0% 100% / 0.12)" : "hsl(var(--border) / 0.55)",
                      background: resolvedDark ? "hsl(0 0% 100% / 0.06)" : "hsl(var(--background))",
                      boxShadow: resolvedDark
                        ? "inset 0 0 0 1px hsl(0 0% 100% / 0.04), 0 8px 32px hsl(0 0% 0% / 0.35)"
                        : "0 2px 24px hsl(0 0% 0% / 0.06)",
                    },
                  }}
                  prefix={
                    <CodeChatComposerPrefix
                      projectId={chat.projectId}
                      topK={chat.topK}
                      projects={chat.projects}
                      projectsLoading={chat.projectsLoading}
                      disabled={chat.loading}
                      onProjectChange={chat.setProjectId}
                      onTopKChange={chat.setTopK}
                      onOpenHistory={() => setMobileHistoryOpen(true)}
                    />
                  }
                  value={chat.input}
                  onChange={(v) => chat.setInput(v)}
                  onSubmit={(msg) => {
                    chat.setInput("");
                    void chat.doSend(msg);
                  }}
                  submitType="enter"
                  loading={chat.loading}
                  placeholder={inputPlaceholder}
                  autoSize={{ minRows: 1, maxRows: 6 }}
                />
              </div>
            </div>
          </div>
        </XProvider>
      </div>
      {mobileHistoryOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/45"
            aria-label={t("chat.closeHistoryDrawer")}
            onClick={() => setMobileHistoryOpen(false)}
          />
          <aside className="absolute inset-x-0 bottom-0 h-[min(72dvh,560px)] rounded-t-2xl border-t bg-background shadow-2xl">
            <div className="flex justify-center pt-2">
              <span className="h-1.5 w-10 rounded-full bg-muted-foreground/30" aria-hidden />
            </div>
            <div className="flex items-center justify-between border-b px-3 py-2">
              <h2 className="text-sm font-medium">{t("chat.historyTitle")}</h2>
              <Button
                type="text"
                size="small"
                icon={<X className="size-4" aria-hidden />}
                aria-label={t("chat.closeHistoryDrawer")}
                onClick={() => setMobileHistoryOpen(false)}
              />
            </div>
            <div className="h-[calc(100%-3rem)] pb-2">
              <CodeChatHistoryCard
                sortedSessions={chat.sortedSessions}
                activeId={chat.activeId}
                loading={chat.loading}
                onNewChat={handleHistoryNewChat}
                onSelectSession={handleHistorySelectSession}
                onDeleteSession={handleHistoryDeleteSession}
              />
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
