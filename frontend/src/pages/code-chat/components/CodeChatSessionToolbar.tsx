import { useEffect, useMemo, useState } from "react";
import { List, SlidersHorizontal } from "lucide-react";
import { Button, Popover } from "antd";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SearchableProjectSelect } from "@/components/SearchableProjectSelect";
import { useI18n } from "@/i18n/I18nContext";
import type { CodeChatProjectOption } from "./types";

export type CodeChatSessionSettingsProps = {
  projectId: string;
  topK: number;
  projects: CodeChatProjectOption[];
  projectsLoading: boolean;
  disabled: boolean;
  onProjectChange: (v: string) => void;
  onTopKChange: (v: number) => void;
  onOpenHistory?: () => void;
};

function clampTopKChat(n: number): number {
  if (!Number.isFinite(n)) return 12;
  return Math.min(30, Math.max(1, Math.round(n)));
}

export function CodeChatRetrievalSettingsForm(props: CodeChatSessionSettingsProps) {
  const { t } = useI18n();
  const { projectId, topK, projects, projectsLoading, disabled, onProjectChange, onTopKChange, onOpenHistory } = props;
  const [topKDraft, setTopKDraft] = useState(() => String(topK));

  useEffect(() => {
    setTopKDraft(String(topK));
  }, [topK]);

  return (
    <div
      className="w-[min(calc(100vw-2.5rem),18rem)] space-y-3 sm:w-80"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {onOpenHistory ? (
        <Button
          type="default"
          size="small"
          className="mb-2 inline-flex h-8 items-center gap-1.5 rounded-md border-border/60 lg:hidden"
          disabled={disabled}
          onClick={() => onOpenHistory()}
          icon={<List className="size-3.5" aria-hidden />}
        >
          {t("chat.historyTitle")}
        </Button>
      ) : null}
      <p className="text-xs leading-snug text-muted-foreground">{t("chat.contextDesc")}</p>
      <div className="space-y-3">
        <div className="min-w-0 space-y-1.5">
          <Label className="text-xs font-medium">{t("search.projectLabel")}</Label>
          <SearchableProjectSelect
            id="code-chat-session-project"
            projects={projects}
            loading={projectsLoading}
            value={projectId}
            onChange={onProjectChange}
            disabled={disabled}
            portaled
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="code-chat-session-topk" className="text-xs font-medium">
            {t("search.topKLabel")}
          </Label>
          <Input
            id="code-chat-session-topk"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={topKDraft}
            disabled={disabled}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (raw === "") {
                setTopKDraft("");
                return;
              }
              if (!/^\d+$/.test(raw)) return;
              setTopKDraft(raw);
              const n = clampTopKChat(Number(raw));
              onTopKChange(n);
              if (String(n) !== raw) setTopKDraft(String(n));
            }}
            onBlur={() => {
              const raw = topKDraft.trim();
              if (raw === "" || !/^\d+$/.test(raw)) {
                const fallback = clampTopKChat(topK);
                setTopKDraft(String(fallback));
                onTopKChange(fallback);
                return;
              }
              const n = clampTopKChat(Number(raw));
              setTopKDraft(String(n));
              onTopKChange(n);
            }}
          />
          <p className="text-xs text-muted-foreground">{t("chat.topKHint")}</p>
        </div>
      </div>
    </div>
  );
}

/** 输入框左侧：仅图标 + Popover，避免顶栏横条（更接近 ChatGPT 输入区） */
export function CodeChatComposerPrefix(props: CodeChatSessionSettingsProps) {
  const { t } = useI18n();
  const { projectId, topK, disabled, projects, onOpenHistory } = props;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const projectSummary = useMemo(() => {
    if (!projectId.trim()) return t("projectSelect.all");
    const p = projects.find((x) => x.project_id === projectId);
    const name = p?.project_name?.trim();
    return name || projectId;
  }, [projectId, projects, t]);

  const titleHint = `${projectSummary} ${t("chat.retrievalTopKChip", { n: topK })}`;

  return (
    <Popover
      placement="topLeft"
      trigger="click"
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      title={<span className="text-sm font-medium">{t("chat.contextTitle")}</span>}
      content={
        <CodeChatRetrievalSettingsForm
          {...props}
          onOpenHistory={
            onOpenHistory
              ? () => {
                  setSettingsOpen(false);
                  onOpenHistory();
                }
              : undefined
          }
        />
      }
    >
      <Button
        type="text"
        size="small"
        disabled={disabled}
        className="size-9 shrink-0 rounded-full text-muted-foreground hover:bg-muted/80 hover:text-foreground"
        aria-label={t("chat.retrievalSettingsAria")}
        title={titleHint}
        icon={<SlidersHorizontal className="size-[1.125rem]" aria-hidden />}
      />
    </Popover>
  );
}
