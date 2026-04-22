import { useEffect, useMemo, useState } from "react";
import { Copy, Pencil, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import type { BubbleItemType } from "@ant-design/x";
import { Button, Image, Input, message } from "antd";
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

function EditableUserBubble({
  turn,
  loading,
  isEditing,
  setEditingUserId,
  handleUserEditConfirm,
}: {
  turn: ChatTurn;
  loading: boolean;
  isEditing: boolean;
  setEditingUserId: (id: string | null) => void;
  handleUserEditConfirm: (userTurnId: string, nextRaw: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(turn.content);

  useEffect(() => {
    if (isEditing) {
      setDraft(turn.content);
      return;
    }
    setDraft(turn.content);
  }, [isEditing, turn.content]);

  const canSubmit = draft.trim().length > 0 && !loading;

  return (
    <div className={isEditing ? "space-y-3 rounded-2xl border border-border/60 bg-background/80 p-3 shadow-sm" : "space-y-2"}>
      {turn.images?.length ? (
        <Image.PreviewGroup>
          <div className="flex flex-wrap gap-2">
            {turn.images.map((image) => (
              <div
                key={image.id}
                className="group overflow-hidden rounded-2xl border border-border/60 bg-background/70 shadow-sm transition hover:border-border hover:shadow"
              >
                <Image
                  src={image.dataUrl}
                  alt={image.name}
                  width={112}
                  height={112}
                  className="object-cover transition group-hover:scale-[1.02]"
                  style={{ objectFit: "cover" }}
                  preview={{ mask: false }}
                />
              </div>
            ))}
          </div>
        </Image.PreviewGroup>
      ) : null}
      {isEditing ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-border/55 bg-muted/35 px-2 py-2">
            <Input.TextArea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoSize={{ minRows: 3, maxRows: 8 }}
              disabled={loading}
              variant="borderless"
              className="bg-transparent"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">{t("chat.editMessageAria")}</div>
            <div className="flex items-center gap-2">
              <Button size="small" className="rounded-lg" onClick={() => setEditingUserId(null)} disabled={loading}>
                {t("chat.editCancel")}
              </Button>
              <Button
                size="small"
                type="primary"
                className="rounded-lg px-3"
                onClick={() => handleUserEditConfirm(turn.id, draft)}
                disabled={!canSubmit}
              >
                {t("chat.editSave")}
              </Button>
            </div>
          </div>
        </div>
      ) : turn.content ? (
        <div className="leading-6">{turn.content}</div>
      ) : null}
    </div>
  );
}

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
        const isEditing = editingUserId === turn.id;
        const showUserActions = !loading && !isEditing;
        return {
          key: turn.id,
          role: "user",
          content: (
            <EditableUserBubble
              turn={turn}
              loading={loading}
              isEditing={isEditing}
              setEditingUserId={setEditingUserId}
              handleUserEditConfirm={handleUserEditConfirm}
            />
          ),
          className: `gv-code-chat-user-bubble gv-code-chat-turn-${turn.id}`,
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
