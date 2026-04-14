import { useEffect } from "react";
import { Button } from "antd";
import { X } from "lucide-react";
import type { ChatSession } from "@/lib/codeChatStorage";
import { useI18n } from "@/i18n/I18nContext";
import { CodeChatHistoryCard } from "./CodeChatHistoryCard";

type CodeChatMobileHistoryDrawerProps = {
  open: boolean;
  sortedSessions: ChatSession[];
  activeId: string;
  loading: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
};

export function CodeChatMobileHistoryDrawer({
  open,
  sortedSessions,
  activeId,
  loading,
  onClose,
  onNewChat,
  onSelectSession,
  onDeleteSession,
}: CodeChatMobileHistoryDrawerProps) {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-black/45"
        aria-label={t("chat.closeHistoryDrawer")}
        onClick={onClose}
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
            onClick={onClose}
          />
        </div>
        <div className="h-[calc(100%-3rem)] pb-2">
          <CodeChatHistoryCard
            sortedSessions={sortedSessions}
            activeId={activeId}
            loading={loading}
            onNewChat={onNewChat}
            onSelectSession={onSelectSession}
            onDeleteSession={onDeleteSession}
          />
        </div>
      </aside>
    </div>
  );
}
