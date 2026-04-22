import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image } from "antd";
import { useParams } from "react-router-dom";
import { MessageSquareMore, RefreshCw, Tags } from "lucide-react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/I18nContext";
import type {
  IssueLabelOptionsResponse,
  IssueRules,
  ProjectIssueDetail,
  ProjectIssueItem,
  ProjectIssueMessage,
  ProjectIssuesResponse,
  UpdateIssueLabelsResponse,
} from "./types";

function formatKeywords(value: string[]): string {
  return value.join(", ");
}

function parseKeywords(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getIssueStateLabel(issue: ProjectIssueItem | ProjectIssueDetail | null, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (!issue) return "—";
  if (issue.status === "closed") return t("projectIssue.stateClosed");
  if (issue.status === "open") return t("projectIssue.stateOpen");
  return issue.status || "—";
}

function getReplyStatusLabel(issue: ProjectIssueItem | ProjectIssueDetail | null, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (!issue) return "—";
  if (issue.latest_reply_status === "posted") return t("projectIssue.replyPosted");
  if (issue.latest_reply_status === "post_failed") return t("projectIssue.replyPostFailed");
  if (issue.latest_reply_status === "blocked") return t("projectIssue.blocked");
  if (issue.latest_reply_status === "needs_human") return t("projectIssue.needsHuman");
  if (issue.latest_reply_status === "generated") return t("projectIssue.generated");
  if (issue.latest_reply_status === "queued") return t("projectIssue.queued");
  if (issue.latest_reply_status === "skipped") return t("projectIssue.replySkipped");
  return t("projectIssue.replyNotTriggered");
}

function formatBubbleTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.replace("T", " ").replace(/\.\d+Z?$/, "").replace("+00:00", "");
  }
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getIssuePrompt(body?: string, title?: string): string {
  const normalizedBody = String(body || "").trim();
  if (normalizedBody) return normalizedBody;
  const normalizedTitle = String(title || "").trim();
  if (normalizedTitle) return normalizedTitle;
  return "—";
}

function getTimelineSortValue(value?: string, fallback = 0): number {
  if (!value) return fallback;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? fallback : time;
}

function isAfterTime(left?: string, right?: string): boolean {
  const leftTime = left ? new Date(left).getTime() : Number.NaN;
  const rightTime = right ? new Date(right).getTime() : Number.NaN;
  if (Number.isNaN(leftTime)) return false;
  if (Number.isNaN(rightTime)) return true;
  return leftTime > rightTime;
}

function normalizeLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of labels) {
    const text = item.trim();
    const lowered = text.toLowerCase();
    if (!text || seen.has(lowered)) continue;
    seen.add(lowered);
    normalized.push(text);
  }
  return normalized;
}

function getDisplayedIssueLabels(issue: ProjectIssueDetail | null): string[] {
  if (!issue) return [];
  const currentLabels = Array.isArray(issue.labels) ? issue.labels : [];
  const autoAppliedLabels = issue.latest_auto_label_result?.applied_labels ?? [];
  const autoRecommendedLabels = issue.latest_auto_label_result?.recommended_labels ?? [];
  return normalizeLabels([...currentLabels, ...autoAppliedLabels, ...autoRecommendedLabels]);
}

function getIssueKey(issue: Pick<ProjectIssueItem, "provider" | "issue_number"> | Pick<ProjectIssueDetail, "provider" | "issue_number"> | null): string | null {
  if (!issue) return null;
  return `${issue.provider}:${issue.issue_number}`;
}

function parseIssueMessageContent(content?: string): { text: string; imageUrls: string[] } {
  const source = String(content || "");
  const imageUrls: string[] = [];
  const imagePattern = /!\[[^\]]*\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)/g;

  const text = source
    .replace(imagePattern, (_, url: string) => {
      const normalizedUrl = String(url || "").trim();
      if (normalizedUrl) {
        imageUrls.push(normalizedUrl);
      }
      return "";
    })
    .replace(/\{width=\d+\s+height=\d+\}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text,
    imageUrls: Array.from(new Set(imageUrls)),
  };
}

function getIssueCreatorName(issue: ProjectIssueItem | ProjectIssueDetail): string {
  const messages = "messages" in issue ? issue.messages : undefined;
  return messages?.find((message: ProjectIssueMessage) => message.kind === "issue_body")?.author || issue.author || "—";
}

export function ProjectIssueTab() {
  const { t } = useI18n();
  const { projectId = "" } = useParams();
  const [rules, setRules] = useState<IssueRules | null>(null);
  const [blockedInput, setBlockedInput] = useState("");
  const [humanInput, setHumanInput] = useState("");
  const [templateInput, setTemplateInput] = useState("");
  const [requirementsInput, setRequirementsInput] = useState("");
  const [availableLabelsInput, setAvailableLabelsInput] = useState("");
  const [labelingInstructionsInput, setLabelingInstructionsInput] = useState("");
  const [issues, setIssues] = useState<ProjectIssueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<ProjectIssueDetail | null>(null);
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [labelOptions, setLabelOptions] = useState<string[]>([]);
  const [labelEditorOpen, setLabelEditorOpen] = useState(false);
  const [draftLabels, setDraftLabels] = useState<string[]>([]);
  const [labelInput, setLabelInput] = useState("");
  const [labelSaving, setLabelSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedIssueRef = useRef<ProjectIssueDetail | null>(null);
  const issueDetailRequestSeqRef = useRef(0);
  const initializedRulesRef = useRef(false);
  const lastSavedRulesRef = useRef<string>("");

  useEffect(() => {
    selectedIssueRef.current = selectedIssue;
  }, [selectedIssue]);

  const loadIssueDetail = useCallback(
    async (issue: ProjectIssueItem | null) => {
      const requestSeq = ++issueDetailRequestSeqRef.current;
      if (!projectId || !issue) {
        setDetailLoading(false);
        setSelectedIssueKey(null);
        setSelectedIssue(null);
        setLabelOptions([]);
        setDraftLabels([]);
        setLabelEditorOpen(false);
        return;
      }
      const issueKey = getIssueKey(issue);
      setSelectedIssueKey(issueKey);
      setDetailLoading(true);
      setSelectedIssue(null);
      setLabelOptions([]);
      setDraftLabels([]);
      setLabelEditorOpen(false);
      setLabelInput("");
      const [detail, options] = await Promise.all([
        apiJson<ProjectIssueDetail>(
          `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issue.provider)}/${encodeURIComponent(issue.issue_number)}`,
        ),
        apiJson<IssueLabelOptionsResponse>(
          `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issue.provider)}/${encodeURIComponent(issue.issue_number)}/labels/options`,
        ).catch(() => null),
      ]);
      if (requestSeq !== issueDetailRequestSeqRef.current) return;
      setSelectedIssue(detail);
      const normalizedCurrentLabels = normalizeLabels(detail.labels ?? []);
      setDraftLabels(normalizedCurrentLabels);
      setLabelOptions(normalizeLabels([...(options?.available_labels ?? []), ...normalizedCurrentLabels]));
      setLabelEditorOpen(false);
      setLabelInput("");
      setDetailLoading(false);
    },
    [projectId],
  );

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [rulesResp, issuesResp] = await Promise.all([
        apiJson<IssueRules>(`/api/projects/${encodeURIComponent(projectId)}/issue-rules`),
        apiJson<ProjectIssuesResponse>(`/api/projects/${encodeURIComponent(projectId)}/issues?limit=50&offset=0`),
      ]);
      setRules(rulesResp);
      setBlockedInput(formatKeywords(rulesResp.blocked_keywords));
      setHumanInput(formatKeywords(rulesResp.require_human_keywords));
      setTemplateInput(rulesResp.reply_template || "");
      setRequirementsInput(rulesResp.reply_requirements || "");
      setAvailableLabelsInput(formatKeywords(rulesResp.available_labels || []));
      setLabelingInstructionsInput(rulesResp.labeling_instructions || "");
      lastSavedRulesRef.current = JSON.stringify({
        auto_post_default: Boolean(rulesResp.auto_post_default),
        blocked_keywords: parseKeywords(formatKeywords(rulesResp.blocked_keywords)),
        require_human_keywords: parseKeywords(formatKeywords(rulesResp.require_human_keywords)),
        reply_template: rulesResp.reply_template || "",
        reply_requirements: rulesResp.reply_requirements || "",
        auto_label_enabled: Boolean(rulesResp.auto_label_enabled),
        auto_apply_labels: rulesResp.auto_apply_labels == null ? true : Boolean(rulesResp.auto_apply_labels),
        available_labels: parseKeywords(formatKeywords(rulesResp.available_labels || [])),
        labeling_instructions: rulesResp.labeling_instructions || "",
      });
      initializedRulesRef.current = true;
      setIssues(issuesResp.issues ?? []);

      const currentSelectedIssue = selectedIssueRef.current;
      const currentSelectedIssueKey = selectedIssueKey;
      const targetIssue = currentSelectedIssueKey
        ? (issuesResp.issues ?? []).find((item) => getIssueKey(item) === currentSelectedIssueKey) ?? null
        : currentSelectedIssue
          ? (issuesResp.issues ?? []).find(
              (item) => item.provider === currentSelectedIssue.provider && item.issue_number === currentSelectedIssue.issue_number,
            ) ?? null
          : issuesResp.issues?.[0] ?? null;
      setSelectedIssueKey(getIssueKey(targetIssue));
      await loadIssueDetail(targetIssue);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("projectIssue.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [loadIssueDetail, projectId, selectedIssueKey, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const replyPreview = useMemo(() => {
    const reply = selectedIssue?.latest_reply_job?.result?.reply;
    return typeof reply === "string" ? reply : selectedIssue?.latest_reply_preview || "";
  }, [selectedIssue]);

  const displayedIssueLabels = useMemo(() => getDisplayedIssueLabels(selectedIssue), [selectedIssue]);

  const timelineMessages = useMemo(() => {
    if (!selectedIssue) {
      return [] as Array<{
        id: string;
        role: "user" | "assistant";
        sender: string;
        title: string;
        content: string;
        time?: string;
        status?: string;
        sortValue: number;
      }>;
    }
    const structuredMessages = Array.isArray(selectedIssue.messages) ? selectedIssue.messages : [];
    if (structuredMessages.length > 0) {
      return structuredMessages
        .map((message: ProjectIssueMessage, index) => {
          const sender = message.author || (message.role === "assistant" ? "bot" : selectedIssue.author || "user");
          const normalizedRole = message.role === "assistant" || sender.toLowerCase() === "bot" ? "assistant" : "user";
          return {
            id: message.id || `${normalizedRole}-${index}`,
            role: normalizedRole,
            sender,
            title:
              message.kind === "issue_body"
                ? `Issue #${selectedIssue.issue_number}`
                : message.kind === "comment"
                  ? `追问 ${index}`
                  : message.status === "posted"
                    ? "自动回复"
                    : "回复预览",
            content: message.body || "—",
            time: message.created_at || undefined,
            status: normalizedRole === "assistant" ? message.status || undefined : undefined,
            sortValue: getTimelineSortValue(message.created_at, index),
          };
        })
        .sort((a, b) => a.sortValue - b.sortValue);
    }
    const items: Array<{
      id: string;
      role: "user" | "assistant";
      sender: string;
      title: string;
      content: string;
      time?: string;
      status?: string;
      sortValue: number;
    }> = [];
    items.push({
      id: "issue-body",
      role: "user",
      sender: selectedIssue.author || "user",
      title: `Issue #${selectedIssue.issue_number}`,
      content: getIssuePrompt(selectedIssue.body, selectedIssue.title),
      time: selectedIssue.created_at || undefined,
      sortValue: getTimelineSortValue(selectedIssue.created_at, 0),
    });
    selectedIssue.comments.forEach((comment, index) => {
      const content = String(comment || "").trim();
      if (!content) return;
      items.push({
        id: `comment-${index}`,
        role: "user",
        sender: selectedIssue.author || "user",
        title: `追问 ${index + 1}`,
        content,
        time: selectedIssue.updated_at || undefined,
        sortValue: getTimelineSortValue(selectedIssue.updated_at, 0) + index + 1,
      });
    });
    if (replyPreview.trim()) {
      const replyTime = selectedIssue.latest_reply_posted_at || selectedIssue.latest_reply_job?.finished_at || undefined;
      const shouldShowReply =
        selectedIssue.latest_reply_status !== "skipped" &&
        (isAfterTime(replyTime, selectedIssue.updated_at) || selectedIssue.latest_reply_status === "posted");
      if (shouldShowReply) {
        items.push({
          id: "assistant-reply",
          role: "assistant",
          sender: "bot",
          title: selectedIssue.latest_reply_status === "posted" ? "自动回复" : "回复预览",
          content: replyPreview,
          time: replyTime,
          status: getReplyStatusLabel(selectedIssue, t),
          sortValue: getTimelineSortValue(replyTime, getTimelineSortValue(selectedIssue.updated_at, 0) + selectedIssue.comments.length + 1),
        });
      }
    }
    return items.sort((a, b) => a.sortValue - b.sortValue);
  }, [replyPreview, selectedIssue, t]);

  async function onSaveRules() {
    if (!projectId || !rules) return;
    const payload = {
      auto_post_default: rules.auto_post_default,
      blocked_keywords: parseKeywords(blockedInput),
      require_human_keywords: parseKeywords(humanInput),
      reply_template: templateInput,
      reply_requirements: requirementsInput,
      auto_label_enabled: Boolean(rules.auto_label_enabled),
      auto_apply_labels: Boolean(rules.auto_apply_labels),
      available_labels: parseKeywords(availableLabelsInput),
      labeling_instructions: labelingInstructionsInput,
    };
    const payloadKey = JSON.stringify(payload);
    if (payloadKey === lastSavedRulesRef.current) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await apiJson<IssueRules>(`/api/projects/${encodeURIComponent(projectId)}/issue-rules`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setRules((prev) =>
        prev
          ? {
              ...prev,
              project_id: saved.project_id,
              updated_at: saved.updated_at,
            }
          : saved,
      );
      lastSavedRulesRef.current = JSON.stringify({
        auto_post_default: Boolean(saved.auto_post_default),
        blocked_keywords: parseKeywords(formatKeywords(saved.blocked_keywords)),
        require_human_keywords: parseKeywords(formatKeywords(saved.require_human_keywords)),
        reply_template: saved.reply_template || "",
        reply_requirements: saved.reply_requirements || "",
        auto_label_enabled: Boolean(saved.auto_label_enabled),
        auto_apply_labels: Boolean(saved.auto_apply_labels),
        available_labels: parseKeywords(formatKeywords(saved.available_labels || [])),
        labeling_instructions: saved.labeling_instructions || "",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("projectIssue.saveFail"));
    } finally {
      setSaving(false);
    }
  }

  function toggleDraftLabel(label: string) {
    setDraftLabels((prev) => {
      const exists = prev.some((item) => item.toLowerCase() === label.toLowerCase());
      return exists ? prev.filter((item) => item.toLowerCase() !== label.toLowerCase()) : normalizeLabels([...prev, label]);
    });
  }

  function addCustomLabel() {
    const normalized = labelInput.trim();
    if (!normalized) return;
    setDraftLabels((prev) => normalizeLabels([...prev, normalized]));
    setLabelOptions((prev) => normalizeLabels([...prev, normalized]));
    setLabelInput("");
  }

  async function onSaveLabels() {
    if (!projectId || !selectedIssue) return;
    setLabelSaving(true);
    setError(null);
    try {
      const response = await apiJson<UpdateIssueLabelsResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(selectedIssue.provider)}/${encodeURIComponent(selectedIssue.issue_number)}/labels`,
        {
          method: "PUT",
          body: JSON.stringify({ labels: normalizeLabels(draftLabels) }),
        },
      );
      const updatedIssue = response.issue;
      if (updatedIssue) {
        setSelectedIssue(updatedIssue);
      } else {
        setSelectedIssue((prev) => (prev ? { ...prev, labels: response.labels } : prev));
      }
      setIssues((prev) =>
        prev.map((item) =>
          item.provider === response.provider && item.issue_number === response.issue_number
            ? { ...item, labels: response.labels, updated_at: updatedIssue?.updated_at ?? item.updated_at }
            : item,
        ),
      );
      setDraftLabels(response.labels);
      setLabelOptions((prev) => normalizeLabels([...prev, ...response.labels]));
      setLabelEditorOpen(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("projectIssue.saveLabelsFail"));
    } finally {
      setLabelSaving(false);
    }
  }

  function onRuleFieldBlur() {
    void onSaveRules();
  }

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[360px_minmax(0,380px)_minmax(0,1fr)]">
      {error ? <div className="xl:col-span-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div> : null}

      <Card className="flex h-[calc(100vh-96px)] min-h-0 flex-col overflow-hidden shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <MessageSquareMore className="size-5 text-primary" aria-hidden />
            <CardTitle className="text-base">{t("projectIssue.rulesTitle")}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-6 pb-6">
          <div className="flex items-center justify-between rounded-lg border px-3 py-3">
            <div>
              <div className="text-sm font-medium">{t("projectIssue.autoPostDefault")}</div>
              <div className="text-xs text-muted-foreground">{t("projectIssue.autoPostDefaultHint")}</div>
            </div>
            <Switch
              checked={Boolean(rules?.auto_post_default)}
              onCheckedChange={(checked) => {
                setRules((prev) => (prev ? { ...prev, auto_post_default: checked } : prev));
                window.setTimeout(() => {
                  void onSaveRules();
                }, 0);
              }}
              disabled={loading || saving}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border px-3 py-3">
            <div>
              <div className="text-sm font-medium">{t("projectIssue.autoLabel")}</div>
              <div className="text-xs text-muted-foreground">{t("projectIssue.autoLabelHint")}</div>
            </div>
            <Switch
              checked={Boolean(rules?.auto_label_enabled)}
              onCheckedChange={(checked) => {
                setRules((prev) => (prev ? { ...prev, auto_label_enabled: checked } : prev));
                window.setTimeout(() => {
                  void onSaveRules();
                }, 0);
              }}
              disabled={loading || saving}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("projectIssue.availableLabels")}</label>
            <Input value={availableLabelsInput} onChange={(e) => setAvailableLabelsInput(e.target.value)} onBlur={onRuleFieldBlur} disabled={loading || saving} placeholder={t("projectIssue.availableLabelsPlaceholder")} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("projectIssue.labelingInstructions")}</label>
            <textarea
              className="min-h-[100px] w-full max-w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={labelingInstructionsInput}
              onChange={(e) => setLabelingInstructionsInput(e.target.value)}
              onBlur={onRuleFieldBlur}
              disabled={loading || saving}
              placeholder={t("projectIssue.labelingInstructionsPlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("projectIssue.blockedKeywords")}</label>
            <Input value={blockedInput} onChange={(e) => setBlockedInput(e.target.value)} onBlur={onRuleFieldBlur} disabled={loading || saving} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("projectIssue.humanKeywords")}</label>
            <Input value={humanInput} onChange={(e) => setHumanInput(e.target.value)} onBlur={onRuleFieldBlur} disabled={loading || saving} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("projectIssue.replyTemplate")}</label>
            <textarea
              className="min-h-[120px] w-full max-w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={templateInput}
              onChange={(e) => setTemplateInput(e.target.value)}
              onBlur={onRuleFieldBlur}
              disabled={loading || saving}
              placeholder={t("projectIssue.replyTemplatePlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("projectIssue.replyRequirements")}</label>
            <textarea
              className="min-h-[120px] w-full max-w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={requirementsInput}
              onChange={(e) => setRequirementsInput(e.target.value)}
              onBlur={onRuleFieldBlur}
              disabled={loading || saving}
              placeholder={t("projectIssue.replyRequirementsPlaceholder")}
            />
          </div>
          {saving ? <div className="pt-2 text-xs text-muted-foreground">{t("projectIssue.autoSaving")}</div> : null}
        </CardContent>
      </Card>

      <Card className="flex h-[calc(100vh-96px)] min-w-0 min-h-0 flex-col shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 px-5">
          <div>
            <CardTitle className="text-base">{t("projectIssue.issueListTitle")}</CardTitle>
          </div>
          <Button variant="outline" size="icon" onClick={() => void load()} disabled={loading} aria-label={t("common.refresh")}>
            <RefreshCw className="size-4" aria-hidden />
          </Button>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 pb-5">
          {issues.length === 0 ? (
            <div className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">{t("projectIssue.empty")}</div>
          ) : (
            issues.map((issue) => {
              const issueKey = getIssueKey(issue);
              const isSelected = selectedIssueKey === issueKey;
              return (
                <button
                  key={`${issue.provider}:${issue.issue_number}`}
                  type="button"
                  onClick={() => {
                    setSelectedIssueKey(issueKey);
                    void loadIssueDetail(issue);
                  }}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${isSelected ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">#{issue.issue_number || "-"} · {issue.title || "—"}</div>
                      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{getIssuePrompt(issue.body, issue.title)}</div>
                      <div className="mt-2 text-[11px] text-muted-foreground">{t("projectIssue.author")}: {getIssueCreatorName(issue)}</div>
                      {issue.latest_reply_error ? <div className="mt-1 line-clamp-2 text-[11px] text-destructive">{issue.latest_reply_error}</div> : null}
                    </div>
                    <div className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{getIssueStateLabel(issue, t)}</div>
                  </div>
                </button>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card className="flex h-[calc(100vh-96px)] min-w-0 min-h-0 flex-col shadow-sm">
        <CardHeader className="space-y-3 px-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">{t("projectIssue.detailTitle")}</CardTitle>
              <CardDescription>
                {detailLoading ? t("projectIssue.detailLoading") : selectedIssue ? `#${selectedIssue.issue_number} · ${selectedIssue.title || "—"}` : t("projectIssue.detailEmpty")}
              </CardDescription>
            </div>
            {selectedIssue ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    setDraftLabels(normalizeLabels(selectedIssue.labels ?? []));
                    setLabelEditorOpen((prev) => !prev);
                    setLabelInput("");
                  }}
                  disabled={labelSaving}
                  aria-label={labelEditorOpen ? t("projectIssue.editLabelsCancelAria") : t("projectIssue.editLabelsAria")}
                  title={labelEditorOpen ? t("projectIssue.editLabelsCancelAria") : t("projectIssue.editLabelsAria")}
                >
                  <Tags className="size-4" aria-hidden />
                </Button>
              </div>
            ) : null}
          </div>
          {detailLoading ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">{t("projectIssue.detailMetaLoading")}</span>
            </div>
          ) : selectedIssue ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                {t("projectIssue.author")}: {getIssueCreatorName(selectedIssue)}
              </span>
              <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">{t("projectIssue.metaIssueStatus")}: {getIssueStateLabel(selectedIssue, t)}</span>
              <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">{t("projectIssue.metaAutoPost")}: {String(selectedIssue.latest_reply_job?.result?.should_auto_post ?? false)}</span>
              <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">{t("projectIssue.metaNeedsHuman")}: {String(selectedIssue.latest_reply_job?.result?.needs_human ?? false)}</span>
              {selectedIssue.latest_reply_status === "skipped" && selectedIssue.latest_reply_job?.result?.skip_reason ? (
                <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                  {t("projectIssue.metaSkipReason")}: {String(selectedIssue.latest_reply_job.result.skip_reason)}
                </span>
              ) : null}
              {displayedIssueLabels.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  {displayedIssueLabels.map((label) => (
                    <span key={label} className="rounded-full border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
                      {label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="min-h-0 flex flex-1 flex-col space-y-4 overflow-hidden px-5 pb-5 text-sm">
          {detailLoading ? (
            <div className="flex min-h-0 flex-1 flex-col rounded-2xl border bg-muted/10 p-4">
              <div className="space-y-3">
                <div className="h-4 w-28 rounded bg-muted/70" />
                <div className="h-3 w-full rounded bg-muted/50" />
                <div className="h-3 w-5/6 rounded bg-muted/50" />
              </div>
              <div className="mt-4 flex-1 rounded-2xl border border-dashed border-border/50 bg-background/40" />
            </div>
          ) : selectedIssue ? (
            <div className="flex min-h-0 flex-1 flex-col space-y-4">
              {labelEditorOpen ? (
                <div className="space-y-3 rounded-lg border bg-background p-3">
                  <div className="text-xs text-muted-foreground">{t("projectIssue.labelEditorHint")}</div>
                  <div className="flex flex-wrap gap-2">
                    {labelOptions.length > 0 ? (
                      labelOptions.map((label) => {
                        const active = draftLabels.some((item) => item.toLowerCase() === label.toLowerCase());
                        return (
                          <button
                            key={label}
                            type="button"
                            onClick={() => toggleDraftLabel(label)}
                            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${active ? "border-primary bg-primary/10 text-primary" : "bg-muted/20 text-muted-foreground hover:bg-muted/40"}`}
                          >
                            {label}
                          </button>
                        );
                      })
                    ) : (
                      <div className="text-xs text-muted-foreground">{t("projectIssue.labelOptionsEmpty")}</div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={labelInput}
                      onChange={(e) => setLabelInput(e.target.value)}
                      placeholder={t("projectIssue.labelInputPlaceholder")}
                      disabled={labelSaving}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCustomLabel();
                        }
                      }}
                    />
                    <Button type="button" variant="secondary" onClick={addCustomLabel} disabled={labelSaving || !labelInput.trim()}>
                      {t("projectIssue.labelAdd")}
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs text-muted-foreground">{t("projectIssue.labelDraftTitle")}</div>
                    <div className="flex flex-wrap gap-2">
                      {draftLabels.length > 0 ? (
                        draftLabels.map((label) => (
                          <button
                            key={label}
                            type="button"
                            onClick={() => toggleDraftLabel(label)}
                            className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs text-primary"
                          >
                            {label}
                          </button>
                        ))
                      ) : (
                        <div className="text-xs text-muted-foreground">{t("projectIssue.labelDraftEmpty")}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setDraftLabels(normalizeLabels(selectedIssue.labels ?? []));
                        setLabelEditorOpen(false);
                        setLabelInput("");
                      }}
                      disabled={labelSaving}
                    >
                      {t("projectIssue.labelCancel")}
                    </Button>
                    <Button type="button" onClick={() => void onSaveLabels()} disabled={labelSaving}>
                      {labelSaving ? t("projectIssue.labelSaving") : t("projectIssue.labelSave")}
                    </Button>
                  </div>
                </div>
              ) : null}

              {selectedIssue.latest_reply_error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {selectedIssue.latest_reply_error}
                </div>
              ) : null}

              <div className="flex min-h-0 flex-1 flex-col rounded-2xl border bg-muted/10 p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{t("projectIssue.timelineTitle")}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">{t("projectIssue.timelineCount", { count: timelineMessages.length })}</div>
                </div>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                  {timelineMessages.length > 0 ? (
                    timelineMessages.map((message) => {
                      const isAssistant = message.role === "assistant";
                      const parsedContent = parseIssueMessageContent(message.content);
                      return (
                        <div key={message.id} className={`flex ${isAssistant ? "justify-end" : "justify-start"}`}>
                          <div className="max-w-[85%] space-y-1.5">
                            <div className={`flex items-center gap-2 px-1 text-[11px] text-muted-foreground ${isAssistant ? "justify-end" : "justify-start"}`}>
                              {isAssistant ? (
                                <>
                                  <span>{formatBubbleTime(message.time) || "—"}</span>
                                  <span className="truncate font-medium text-foreground">{message.sender}</span>
                                </>
                              ) : (
                                <>
                                  <span className="truncate font-medium text-foreground">{message.sender}</span>
                                  <span>{formatBubbleTime(message.time) || "—"}</span>
                                </>
                              )}
                            </div>
                            <div className={`rounded-2xl border px-4 py-3 shadow-sm ${isAssistant ? "border-primary/20 bg-primary/8" : "bg-background"}`}>
                              <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                                <span className="truncate">{message.title}</span>
                                {message.status ? <span className="shrink-0">{message.status}</span> : null}
                              </div>
                              <div className="space-y-3">
                                {parsedContent.text ? (
                                  <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{parsedContent.text}</div>
                                ) : null}
                                {parsedContent.imageUrls.length > 0 ? (
                                  <Image.PreviewGroup>
                                    <div className="flex flex-wrap gap-2">
                                      {parsedContent.imageUrls.map((url, index) => (
                                        <div key={`${message.id}-image-${index}`} className="group overflow-hidden rounded-2xl border border-border/60 bg-background/70 shadow-sm transition hover:border-border hover:shadow">
                                          <Image
                                            src={url}
                                            alt={`issue-image-${index + 1}`}
                                            width={160}
                                            height={120}
                                            className="object-cover transition group-hover:scale-[1.02]"
                                            style={{ objectFit: "cover" }}
                                            preview={{ mask: false }}
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  </Image.PreviewGroup>
                                ) : null}
                                {!parsedContent.text && parsedContent.imageUrls.length === 0 ? (
                                  <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{message.content || "—"}</div>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground">{t("projectIssue.timelineEmpty")}</div>
                  )}
                </div>
              </div>

            </div>
          ) : (
            <div className="rounded-md border border-dashed px-4 py-6 text-muted-foreground">{t("projectIssue.detailEmpty")}</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
