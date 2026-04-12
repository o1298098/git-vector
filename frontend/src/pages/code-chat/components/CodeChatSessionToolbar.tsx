import { useMemo } from "react";
import { SlidersHorizontal } from "lucide-react";
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
};

export function CodeChatRetrievalSettingsForm(props: CodeChatSessionSettingsProps) {
  const { t } = useI18n();
  const { projectId, topK, projects, projectsLoading, disabled, onProjectChange, onTopKChange } = props;
  return (
    <div className="w-[min(calc(100vw-2.5rem),18rem)] space-y-3 sm:w-80">
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
            type="number"
            min={1}
            max={30}
            value={topK}
            disabled={disabled}
            onChange={(e) => onTopKChange(Math.min(30, Math.max(1, Number(e.target.value) || 12)))}
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
  const { projectId, topK, disabled, projects } = props;
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
      title={<span className="text-sm font-medium">{t("chat.contextTitle")}</span>}
      content={<CodeChatRetrievalSettingsForm {...props} />}
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
