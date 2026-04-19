import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { MessageSquareMore, RefreshCw } from "lucide-react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/I18nContext";
import type { IssueRules, ProjectIssueDetail, ProjectIssueItem, ProjectIssueMessage, ProjectIssuesResponse } from "./types";

function formatKeywords(value: string[]): string {
  return value.join(", ");
}

function parseKeywords(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getIssueStateLabel(issue: ProjectIssueItem | ProjectIssueDetail | null): string {
  if (!issue) return "—";
  if (issue.status === "closed") return "已关闭";
  if (issue.status === "open") return "进行中";
  return issue.status || "—";
}

function getReplyStatusLabel(issue: ProjectIssueItem | ProjectIssueDetail | null, t: (key: string) => string): string {
  if (!issue) return "—";
  if (issue.latest_reply_status === "posted") return "已发布";
  if (issue.latest_reply_status === "post_failed") return "发布失败";
  if (issue.latest_reply_status === "blocked") return t("projectIssue.blocked");
  if (issue.latest_reply_status === "needs_human") return t("projectIssue.needsHuman");
  if (issue.latest_reply_status === "generated") return t("projectIssue.generated");
  if (issue.latest_reply_status === "queued") return t("projectIssue.queued");
  if (issue.latest_reply_status === "skipped") return "无需回复";
  return "未触发";
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

export function ProjectIssueTab() {
  const { t } = useI18n();
  const { projectId = "" } = useParams();
  const [rules, setRules] = useState<IssueRules | null>(null);
  const [blockedInput, setBlockedInput] = useState("");
  const [humanInput, setHumanInput] = useState("");
  const [templateInput, setTemplateInput] = useState("");
  const [requirementsInput, setRequirementsInput] = useState("");
  const [issues, setIssues] = useState<ProjectIssueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<ProjectIssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedIssueRef = useRef<ProjectIssueDetail | null>(null);
  const initializedRulesRef = useRef(false);
  const lastSavedRulesRef = useRef<string>("");

  useEffect(() => {
    selectedIssueRef.current = selectedIssue;
  }, [selectedIssue]);

  const loadIssueDetail = useCallback(
    async (issue: ProjectIssueItem | null) => {
      if (!projectId || !issue) {
        setSelectedIssue(null);
        return;
      }
      const detail = await apiJson<ProjectIssueDetail>(
        `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issue.provider)}/${encodeURIComponent(issue.issue_number)}`,
      );
      setSelectedIssue(detail);
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
      lastSavedRulesRef.current = JSON.stringify({
        auto_post_default: Boolean(rulesResp.auto_post_default),
        blocked_keywords: parseKeywords(formatKeywords(rulesResp.blocked_keywords)),
        require_human_keywords: parseKeywords(formatKeywords(rulesResp.require_human_keywords)),
        reply_template: rulesResp.reply_template || "",
        reply_requirements: rulesResp.reply_requirements || "",
      });
      initializedRulesRef.current = true;
      setIssues(issuesResp.issues ?? []);

      const currentSelectedIssue = selectedIssueRef.current;
      const targetIssue = currentSelectedIssue
        ? (issuesResp.issues ?? []).find(
            (item) => item.provider === currentSelectedIssue.provider && item.issue_number === currentSelectedIssue.issue_number,
          ) ?? null
        : issuesResp.issues?.[0] ?? null;
      await loadIssueDetail(targetIssue);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("projectIssue.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [loadIssueDetail, projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const replyPreview = useMemo(() => {
    const reply = selectedIssue?.latest_reply_job?.result?.reply;
    return typeof reply === "string" ? reply : selectedIssue?.latest_reply_preview || "";
  }, [selectedIssue]);

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
      setRules(saved);
      setBlockedInput(formatKeywords(saved.blocked_keywords));
      setHumanInput(formatKeywords(saved.require_human_keywords));
      setTemplateInput(saved.reply_template || "");
      setRequirementsInput(saved.reply_requirements || "");
      lastSavedRulesRef.current = JSON.stringify({
        auto_post_default: Boolean(saved.auto_post_default),
        blocked_keywords: parseKeywords(formatKeywords(saved.blocked_keywords)),
        require_human_keywords: parseKeywords(formatKeywords(saved.require_human_keywords)),
        reply_template: saved.reply_template || "",
        reply_requirements: saved.reply_requirements || "",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("projectIssue.saveFail"));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!initializedRulesRef.current || !projectId || !rules) return;
    const timer = window.setTimeout(() => {
      void onSaveRules();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [projectId, rules, blockedInput, humanInput, templateInput, requirementsInput]);

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
              onCheckedChange={(checked) => setRules((prev) => (prev ? { ...prev, auto_post_default: checked } : prev))}
              disabled={loading || saving}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("projectIssue.blockedKeywords")}</label>
            <Input value={blockedInput} onChange={(e) => setBlockedInput(e.target.value)} disabled={loading || saving} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("projectIssue.humanKeywords")}</label>
            <Input value={humanInput} onChange={(e) => setHumanInput(e.target.value)} disabled={loading || saving} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("projectIssue.replyTemplate")}</label>
            <textarea
              className="min-h-[120px] w-full max-w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={templateInput}
              onChange={(e) => setTemplateInput(e.target.value)}
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
              disabled={loading || saving}
              placeholder={t("projectIssue.replyRequirementsPlaceholder")}
            />
          </div>
          {saving ? <div className="pt-2 text-xs text-muted-foreground">正在自动保存…</div> : null}
        </CardContent>
      </Card>

      <Card className="flex h-[calc(100vh-96px)] min-w-0 min-h-0 flex-col shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">{t("projectIssue.issueListTitle")}</CardTitle>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="size-4" aria-hidden />
            {t("common.refresh")}
          </Button>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {issues.length === 0 ? (
            <div className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">{t("projectIssue.empty")}</div>
          ) : (
            issues.map((issue) => (
              <button
                key={`${issue.provider}:${issue.issue_number}`}
                type="button"
                onClick={() => void loadIssueDetail(issue)}
                className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${selectedIssue?.provider === issue.provider && selectedIssue?.issue_number === issue.issue_number ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">#{issue.issue_number || "-"} · {issue.title || "—"}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{getIssuePrompt(issue.body, issue.title)}</div>
                    <div className="mt-2 text-[11px] text-muted-foreground">{t("projectIssue.author")}: {issue.author || "—"}</div>
                    {issue.latest_reply_error ? <div className="mt-1 line-clamp-2 text-[11px] text-destructive">{issue.latest_reply_error}</div> : null}
                  </div>
                  <div className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{getIssueStateLabel(issue)}</div>
                </div>
              </button>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="flex h-[calc(100vh-96px)] min-w-0 min-h-0 flex-col shadow-sm">
        <CardHeader className="space-y-3">
          <div>
            <CardTitle className="text-base">{t("projectIssue.detailTitle")}</CardTitle>
            <CardDescription>
              {selectedIssue ? `#${selectedIssue.issue_number} · ${selectedIssue.title || "—"}` : t("projectIssue.detailEmpty")}
            </CardDescription>
          </div>
          {selectedIssue ? (
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                {t("projectIssue.author")}: {selectedIssue.messages?.find((message) => message.role !== "assistant")?.author || selectedIssue.author || "—"}
              </span>
              <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">Issue 状态: {getIssueStateLabel(selectedIssue)}</span>
              <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">自动发布: {String(selectedIssue.latest_reply_job?.result?.should_auto_post ?? false)}</span>
              <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">人工介入: {String(selectedIssue.latest_reply_job?.result?.needs_human ?? false)}</span>
              {selectedIssue.latest_reply_status === "skipped" && selectedIssue.latest_reply_job?.result?.skip_reason ? (
                <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                  跳过原因: {String(selectedIssue.latest_reply_job.result.skip_reason)}
                </span>
              ) : null}
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="min-h-0 flex flex-1 flex-col space-y-4 overflow-hidden pr-1 text-sm">
          {selectedIssue ? (
            <div className="flex min-h-0 flex-1 flex-col space-y-4">
              {selectedIssue.labels.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {selectedIssue.labels.map((label) => (
                    <span key={label} className="rounded-full border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
                      {label}
                    </span>
                  ))}
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
                    <div className="text-sm font-medium">对话记录</div>
                  </div>
                  <div className="text-xs text-muted-foreground">{timelineMessages.length} 条消息</div>
                </div>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                  {timelineMessages.length > 0 ? (
                    timelineMessages.map((message) => {
                      const isAssistant = message.role === "assistant";
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
                              <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{message.content || "—"}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground">暂无可展示的对话内容</div>
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
