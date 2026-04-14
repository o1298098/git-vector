import { useMemo } from "react";
import { Copy, Pencil, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import type { BubbleItemType } from "@ant-design/x";
import { Button, message } from "antd";
import type { StoredChatTurn as ChatTurn } from "@/lib/codeChatStorage";
import { useI18n } from "@/i18n/I18nContext";
import { AssistantMarkdownBubble } from "./AssistantMarkdownBubble";

type Params = {
  turns: ChatTurn[];
  loading: boolean;
  resolvedDark: boolean;
  editingUserId: string | null;
  setEditingUserId: (id: string | null) => void;
  handleUserEditConfirm: (userTurnId: string, nextRaw: string) => void;
  handleRetryAssistant: (assistantTurnId: string) => void;
  feedbackByTurn: Record<string, 1 | -1>;
  submitFeedback: (assistantTurnId: string, rating: 1 | -1) => Promise<"accepted" | "duplicate" | "failed">;
};

export function useCodeChatBubbleItems({
  turns,
  loading,
  resolvedDark,
  editingUserId,
  setEditingUserId,
  handleUserEditConfirm,
  handleRetryAssistant,
  feedbackByTurn,
  submitFeedback,
}: Params): BubbleItemType[] {
  const { t } = useI18n();

  const lastCompletedAssistantId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const row = turns[i];
      if (row.role === "assistant" && !row.streaming) return row.id;
    }
    return null;
  }, [turns]);

  return useMemo(() => {
    const items: BubbleItemType[] = turns.map((turn) => {
      if (turn.role === "user") {
        const showUserActions = !loading && editingUserId !== turn.id;
        return {
          key: turn.id,
          role: "user",
          content: turn.content,
          className: `gv-code-chat-user-bubble gv-code-chat-turn-${turn.id}`,
          editable: {
            editing: editingUserId === turn.id,
            okText: t("chat.editSave"),
            cancelText: t("chat.editCancel"),
          },
          onEditConfirm: (next: string) => handleUserEditConfirm(turn.id, next),
          onEditCancel: () => setEditingUserId(null),
          extra: showUserActions ? (
            <div className="flex items-center gap-0.5">
              <Button
                type="text"
                size="small"
                className="text-muted-foreground hover:text-foreground"
                icon={<Copy className="size-3.5" aria-hidden />}
                aria-label={t("chat.copyMessageAria")}
                onClick={() => {
                  void navigator.clipboard.writeText(turn.content).then(
                    () => message.success(t("chat.copyDone")),
                    () => message.error(t("chat.copyFail")),
                  );
                }}
              />
              <Button
                type="text"
                size="small"
                className="text-muted-foreground hover:text-foreground"
                icon={<Pencil className="size-3.5" aria-hidden />}
                aria-label={t("chat.editMessageAria")}
                onClick={() => setEditingUserId(turn.id)}
              />
            </div>
          ) : null,
        };
      }
      const pendingReply = turn.streaming === true && !turn.content.trim();
      const showRetry =
        !loading &&
        !turn.streaming &&
        turn.id === lastCompletedAssistantId &&
        turn.content.trim().length > 0;
      const canCopyAssistant = !pendingReply && turn.content.trim().length > 0;
      const feedback = feedbackByTurn[turn.id] ?? null;
      return {
        key: turn.id,
        role: "ai",
        className: `gv-code-chat-assistant-bubble gv-code-chat-turn-${turn.id}`,
        loading: pendingReply,
        footerPlacement: "outer-end",
        footer:
          canCopyAssistant || showRetry ? (
            <div className="flex items-center gap-0.5">
              {canCopyAssistant ? (
                <Button
                  type="text"
                  size="small"
                  className="text-muted-foreground hover:text-foreground"
                  icon={<Copy className="size-3.5" aria-hidden />}
                  aria-label={t("chat.copyReplyAria")}
                  onClick={() => {
                    void navigator.clipboard.writeText(turn.content).then(
                      () => message.success(t("chat.copyDone")),
                      () => message.error(t("chat.copyFail")),
                    );
                  }}
                />
              ) : null}
              {showRetry ? (
                <Button
                  type="text"
                  size="small"
                  className="text-muted-foreground hover:text-foreground"
                  icon={<RefreshCw className="size-3.5" aria-hidden />}
                  aria-label={t("chat.retryAria")}
                  onClick={() => handleRetryAssistant(turn.id)}
                />
              ) : null}
              {!turn.streaming && turn.content.trim().length > 0 ? (
                <>
                  <Button
                    type="text"
                    size="small"
                    className={`text-muted-foreground hover:text-foreground ${feedback === 1 ? "text-emerald-600" : ""}`}
                    icon={<ThumbsUp className="size-3.5" aria-hidden />}
                    aria-label={t("chat.feedbackHelpful")}
                    onClick={() => {
                      void submitFeedback(turn.id, 1).then((status) => {
                        if (status === "accepted") message.success(t("chat.feedbackSubmitSuccess"));
                        else if (status === "duplicate") message.info(t("chat.feedbackAlreadySubmitted"));
                        else message.error(t("chat.feedbackSubmitFail"));
                      });
                    }}
                    disabled={feedback != null}
                  />
                  <Button
                    type="text"
                    size="small"
                    className={`text-muted-foreground hover:text-foreground ${feedback === -1 ? "text-destructive" : ""}`}
                    icon={<ThumbsDown className="size-3.5" aria-hidden />}
                    aria-label={t("chat.feedbackNotHelpful")}
                    onClick={() => {
                      void submitFeedback(turn.id, -1).then((status) => {
                        if (status === "accepted") message.success(t("chat.feedbackSubmitSuccess"));
                        else if (status === "duplicate") message.info(t("chat.feedbackAlreadySubmitted"));
                        else message.error(t("chat.feedbackSubmitFail"));
                      });
                    }}
                    disabled={feedback != null}
                  />
                </>
              ) : null}
            </div>
          ) : null,
        content: pendingReply ? (
          ""
        ) : (
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
  }, [
    turns,
    loading,
    resolvedDark,
    editingUserId,
    t,
    handleUserEditConfirm,
    handleRetryAssistant,
    feedbackByTurn,
    submitFeedback,
    lastCompletedAssistantId,
    setEditingUserId,
  ]);
}
