import { Plus, X } from "lucide-react";
import { Button } from "antd";
import type { ChatSession } from "@/lib/codeChatStorage";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nContext";

export type CodeChatHistoryCardProps = {
  sortedSessions: ChatSession[];
  activeId: string;
  loading: boolean;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  className?: string;
};

export function CodeChatHistoryCard({
  sortedSessions,
  activeId,
  loading,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  className,
}: CodeChatHistoryCardProps) {
  const { t } = useI18n();
  return (
    <section
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 px-3 py-3 sm:px-3.5 sm:py-3.5",
        className,
      )}
      aria-labelledby="code-chat-history-heading"
    >
      <h2 id="code-chat-history-heading" className="sr-only">
        {t("chat.historyTitle")}
      </h2>
      <Button
        type="default"
        className="flex h-9 w-full shrink-0 items-center justify-start gap-1.5 rounded-lg border border-border/60 bg-background px-3 text-left text-sm font-medium text-foreground shadow-none hover:bg-muted/60"
        onClick={onNewChat}
        disabled={loading}
      >
        <Plus className="size-3.5 shrink-0 opacity-70" aria-hidden />
        {t("chat.newChat")}
      </Button>
      <ul
        className="min-h-0 min-w-0 flex-1 basis-0 space-y-1 overflow-y-auto overflow-x-hidden overscroll-contain"
        role="list"
      >
        {sortedSessions.map((s) => {
          const label = s.title.trim() || t("chat.newChat");
          const isActive = s.id === activeId;
          return (
            <li key={s.id} className="group min-w-0">
              <div
                className={cn(
                  "flex min-h-[2.5rem] min-w-0 items-stretch gap-0.5 rounded-lg px-2 py-1.5 transition-colors",
                  isActive
                    ? "bg-background/90 text-foreground dark:bg-background/35"
                    : "text-muted-foreground hover:bg-background/50 hover:text-foreground dark:hover:bg-background/25",
                  loading && "pointer-events-none opacity-60",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  disabled={loading}
                  className={cn(
                    "min-w-0 flex-1 truncate px-0.5 py-1 text-left text-sm leading-snug transition-colors",
                    isActive ? "font-medium" : "text-inherit",
                  )}
                  onClick={() => onSelectSession(s.id)}
                >
                  {label}
                </button>
                <button
                  type="button"
                  className={cn(
                    "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 transition-opacity duration-150",
                    "hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
                    "disabled:pointer-events-none disabled:opacity-40",
                    "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
                  )}
                  aria-label={t("chat.deleteSessionAria")}
                  title={t("chat.deleteSession")}
                  disabled={loading}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSession(s.id);
                  }}
                >
                  <X className="size-3.5" strokeWidth={2} aria-hidden />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
