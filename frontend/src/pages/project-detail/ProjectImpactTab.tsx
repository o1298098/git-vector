import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertCircle, GitBranch, GitCommitHorizontal, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";
import type { ImpactRun, ImpactRunsResponse } from "./types";

type ImpactFileFact = {
  path: string;
  status: string;
  previous_path?: string;
  added: number;
  deleted: number;
  changes: number;
  matched_categories: string[];
  facts: string[];
  risk_score: number;
  file_role?: string;
  change_summary?: string;
  impact_summary?: string;
  evidence?: string[];
};

type StructuredSuggestion = {
  title: string;
  detail?: string;
};

type ReviewerSuggestion = {
  label: string;
  detail?: string;
};

function shortSha(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text) return "—";
  return text.length > 8 ? text.slice(0, 8) : text;
}

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asDisplayText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const row = value as Record<string, unknown>;
  const preferredKeys = [
    "text",
    "label",
    "title",
    "summary",
    "content",
    "description",
    "reason",
    "name",
    "value",
  ];

  for (const key of preferredKeys) {
    const text = asText(row[key]);
    if (text) return text;
  }

  const nestedKeys = ["item", "data", "detail"];
  for (const key of nestedKeys) {
    const text = asDisplayText(row[key]);
    if (text) return text;
  }

  const entries = Object.entries(row)
    .map(([key, item]) => {
      const text = asDisplayText(item);
      return text ? `${key}: ${text}` : "";
    })
    .filter(Boolean);

  return entries.join(" | ");
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asDisplayText(item)).filter(Boolean) : [];
}

function asStructuredSuggestions(value: unknown): StructuredSuggestion[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === "string") {
        const title = item.trim();
        return title ? { title } : null;
      }
      if (!item || typeof item !== "object") {
        return null;
      }

      const row = item as Record<string, unknown>;
      const title =
        asText(row.title) ||
        asText(row.label) ||
        asText(row.summary) ||
        asText(row.text) ||
        asText(row.name) ||
        asText(row.value) ||
        asDisplayText(row.item) ||
        asDisplayText(row.data);

      const detail =
        asText(row.detail) ||
        asText(row.description) ||
        asText(row.reason) ||
        asText(row.content) ||
        asText(row.note) ||
        undefined;

      if (!title) {
        const fallback = asDisplayText(item);
        return fallback ? { title: fallback } : null;
      }

      return { title, detail: detail && detail !== title ? detail : undefined };
    })
    .filter((item): item is StructuredSuggestion => !!item);
}

function asReviewerSuggestions(value: unknown): ReviewerSuggestion[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === "string") {
        const label = item.trim();
        return label ? { label } : null;
      }
      if (!item || typeof item !== "object") {
        return null;
      }

      const row = item as Record<string, unknown>;
      const label =
        asText(row.label) ||
        asText(row.name) ||
        asText(row.title) ||
        asText(row.role) ||
        asText(row.team) ||
        asText(row.owner) ||
        asText(row.reviewer) ||
        asDisplayText(row.item) ||
        asDisplayText(row.data);

      const detail =
        asText(row.reason) ||
        asText(row.description) ||
        asText(row.summary) ||
        asText(row.detail) ||
        undefined;

      if (!label) {
        const fallback = asDisplayText(item);
        return fallback ? { label: fallback } : null;
      }

      return { label, detail: detail && detail !== label ? detail : undefined };
    })
    .filter((item): item is ReviewerSuggestion => !!item);
}

function StructuredSuggestionList({ items }: { items: StructuredSuggestion[] }) {
  if (!items.length) {
    return <div className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">—</div>;
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={`${item.title}-${index}`} className="rounded-lg bg-muted/30 px-3 py-2 text-sm text-foreground">
          <div className="leading-6">{item.title}</div>
          {item.detail ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</div> : null}
        </div>
      ))}
    </div>
  );
}

function ReviewerSuggestionList({ items }: { items: ReviewerSuggestion[] }) {
  if (!items.length) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="rounded-full border bg-muted/20 px-2.5 py-1 text-[11px] leading-5 text-foreground">
          {item.detail ? `${item.label} · ${item.detail}` : item.label}
        </span>
      ))}
    </div>
  );
}

function formatDateTimeToSeconds(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text) return "—";
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) {
    const pad = (num: number) => String(num).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  return text.replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, "").replace("+00:00", "").trim();
}

function riskTone(value: string | null | undefined) {
  const risk = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");

  if (["critical", "highest", "high", "高", "高风险", "3"].includes(risk)) {
    return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300";
  }
  if (["moderate", "medium", "med", "warning", "warn", "中", "中等", "中风险", "2"].includes(risk)) {
    return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300";
  }
  if (["low", "minor", "safe", "info", "低", "低风险", "1"].includes(risk)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300";
  }
  return "border-border bg-muted/40 text-muted-foreground";
}

function SectionList({ items }: { items: string[] }) {
  if (!items.length) {
    return <div className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">—</div>;
  }
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item} className="rounded-lg bg-muted/30 px-3 py-2 text-sm leading-6 text-foreground">
          {item}
        </div>
      ))}
    </div>
  );
}

function TagList({ items }: { items: string[] }) {
  if (!items.length) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span key={item} className="rounded-full border bg-muted/20 px-2.5 py-1 text-[11px] leading-5 text-foreground">
          {item}
        </span>
      ))}
    </div>
  );
}

function asFileFacts(value: unknown): ImpactFileFact[] {
  if (!Array.isArray(value)) return [];

  const result: ImpactFileFact[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;

    const row = item as Record<string, unknown>;
    const path = String(row.path ?? "").trim();
    if (!path) continue;

    const fact: ImpactFileFact = {
      path,
      status: String(row.status ?? "M").trim() || "M",
      added: Number(row.added ?? 0) || 0,
      deleted: Number(row.deleted ?? 0) || 0,
      changes: Number(row.changes ?? 0) || 0,
      matched_categories: asList(row.matched_categories),
      facts: asList(row.facts),
      risk_score: Number(row.risk_score ?? 0) || 0,
      file_role: String(row.file_role ?? "").trim() || undefined,
      change_summary: String(row.change_summary ?? "").trim() || undefined,
      impact_summary: String(row.impact_summary ?? "").trim() || undefined,
      evidence: asList(row.evidence),
    };

    const previousPath = String(row.previous_path ?? "").trim();
    if (previousPath) {
      fact.previous_path = previousPath;
    }

    result.push(fact);
  }

  return result;
}

function fileStatusTone(status: string) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized.startsWith("A")) return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300";
  if (normalized.startsWith("D")) return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300";
  if (normalized.startsWith("R")) return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-300";
  return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300";
}

function fileRiskTone(score: number) {
  if (score >= 6) return "text-red-600 dark:text-red-300";
  if (score >= 3) return "text-amber-600 dark:text-amber-300";
  return "text-emerald-600 dark:text-emerald-300";
}

function summarizeTopDirectories(paths: string[], limit = 6) {
  const counts = new Map<string, number>();
  for (const raw of paths) {
    const parts = String(raw || "")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    const label = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] || "root";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => `${label} (${count})`);
}

const DEFAULT_VISIBLE_FILES = 20;
const DEFAULT_VISIBLE_FILE_FACTS = 6;
const DEFAULT_VISIBLE_RISKS = 5;
const DEFAULT_VISIBLE_VALIDATION_ITEMS = 3;

export function ProjectImpactTab() {
  const { t } = useI18n();
  const { projectId = "" } = useParams();
  const [runs, setRuns] = useState<ImpactRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<ImpactRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [showAllFileFacts, setShowAllFileFacts] = useState(false);
  const [showAllChangeFacts, setShowAllChangeFacts] = useState(false);
  const [showAllDirectImpacts, setShowAllDirectImpacts] = useState(false);
  const [showAllRisks, setShowAllRisks] = useState(false);
  const [showAllCrossSystemImpact, setShowAllCrossSystemImpact] = useState(false);
  const [showAllVerificationFocus, setShowAllVerificationFocus] = useState(false);
  const [showAllTests, setShowAllTests] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const llmSummary = useMemo(() => {
    const value = selectedRun?.summary?.llm;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  }, [selectedRun]);

  const changedFiles = useMemo(() => asList(selectedRun?.summary?.changed_files), [selectedRun]);
  const filteredChangedFiles = useMemo(() => {
    const keyword = fileQuery.trim().toLowerCase();
    if (!keyword) return changedFiles;
    return changedFiles.filter((file) => file.toLowerCase().includes(keyword));
  }, [changedFiles, fileQuery]);
  const visibleChangedFiles = useMemo(
    () => (showAllFiles ? filteredChangedFiles : filteredChangedFiles.slice(0, DEFAULT_VISIBLE_FILES)),
    [filteredChangedFiles, showAllFiles],
  );
  const hiddenFileCount = Math.max(0, filteredChangedFiles.length - visibleChangedFiles.length);
  const topDirectories = useMemo(() => summarizeTopDirectories(filteredChangedFiles.length ? filteredChangedFiles : changedFiles), [changedFiles, filteredChangedFiles]);
  const changedModules = useMemo(() => asList(selectedRun?.summary?.changed_modules), [selectedRun]);
  const affectedAreas = useMemo(() => asList(selectedRun?.summary?.affected_areas), [selectedRun]);
  const fileFacts = useMemo(() => {
    const rows = asFileFacts((selectedRun?.summary?.diff_analysis as Record<string, unknown> | undefined)?.file_facts);
    return rows
      .filter((item) => item.risk_score > 0 || !!item.impact_summary || (item.evidence?.length ?? 0) > 0)
      .sort((a, b) => b.risk_score - a.risk_score || b.changes - a.changes || a.path.localeCompare(b.path));
  }, [selectedRun]);
  const visibleFileFacts = useMemo(
    () => (showAllFileFacts ? fileFacts : fileFacts.slice(0, DEFAULT_VISIBLE_FILE_FACTS)),
    [fileFacts, showAllFileFacts],
  );
  const hiddenFileFactsCount = Math.max(0, fileFacts.length - visibleFileFacts.length);
  const changeFacts = useMemo(() => asList(selectedRun?.summary?.change_facts), [selectedRun]);
  const visibleChangeFacts = useMemo(
    () => (showAllChangeFacts ? changeFacts : changeFacts.slice(0, DEFAULT_VISIBLE_VALIDATION_ITEMS)),
    [changeFacts, showAllChangeFacts],
  );
  const hiddenChangeFactsCount = Math.max(0, changeFacts.length - visibleChangeFacts.length);
  const directImpacts = useMemo(() => asList(selectedRun?.summary?.direct_impacts), [selectedRun]);
  const visibleDirectImpacts = useMemo(
    () => (showAllDirectImpacts ? directImpacts : directImpacts.slice(0, DEFAULT_VISIBLE_RISKS)),
    [directImpacts, showAllDirectImpacts],
  );
  const hiddenDirectImpactsCount = Math.max(0, directImpacts.length - visibleDirectImpacts.length);
  const diffRiskReasons = useMemo(() => asList(selectedRun?.summary?.risk_reasons), [selectedRun]);
  const crossSystemImpact = useMemo(() => asList(selectedRun?.summary?.cross_system_impact), [selectedRun]);
  const visibleCrossSystemImpact = useMemo(
    () => (showAllCrossSystemImpact ? crossSystemImpact : crossSystemImpact.slice(0, DEFAULT_VISIBLE_VALIDATION_ITEMS)),
    [crossSystemImpact, showAllCrossSystemImpact],
  );
  const hiddenCrossSystemImpactCount = Math.max(0, crossSystemImpact.length - visibleCrossSystemImpact.length);
  const verificationFocus = useMemo(() => asList(selectedRun?.summary?.verification_focus), [selectedRun]);
  const visibleVerificationFocus = useMemo(
    () => (showAllVerificationFocus ? verificationFocus : verificationFocus.slice(0, DEFAULT_VISIBLE_VALIDATION_ITEMS)),
    [showAllVerificationFocus, verificationFocus],
  );
  const hiddenVerificationFocusCount = Math.max(0, verificationFocus.length - visibleVerificationFocus.length);
  const topLevelAreas = useMemo(() => asList((selectedRun?.summary?.repository_snapshot as Record<string, unknown> | undefined)?.top_level_areas), [selectedRun]);
  const totalIndexableFiles = useMemo(() => {
    const value = (selectedRun?.summary?.repository_snapshot as Record<string, unknown> | undefined)?.total_indexable_files;
    return typeof value === "number" ? value : Number(value || 0);
  }, [selectedRun]);
  const impactScope = useMemo(() => asList(llmSummary?.impact_scope), [llmSummary]);
  const risks = useMemo(() => asList(llmSummary?.risks), [llmSummary]);
  const riskItems = useMemo(() => {
    const preferred = diffRiskReasons.length ? diffRiskReasons : [...impactScope, ...risks];
    return preferred;
  }, [diffRiskReasons, impactScope, risks]);
  const visibleRiskItems = useMemo(() => (showAllRisks ? riskItems : riskItems.slice(0, DEFAULT_VISIBLE_RISKS)), [riskItems, showAllRisks]);
  const hiddenRiskCount = Math.max(0, riskItems.length - visibleRiskItems.length);
  const tests = useMemo(() => asStructuredSuggestions(llmSummary?.tests), [llmSummary]);
  const visibleTests = useMemo(() => (showAllTests ? tests : tests.slice(0, DEFAULT_VISIBLE_VALIDATION_ITEMS)), [showAllTests, tests]);
  const hiddenTestsCount = Math.max(0, tests.length - visibleTests.length);
  const reviewers = useMemo(() => asReviewerSuggestions(llmSummary?.reviewers), [llmSummary]);
  const commitMessage = useMemo(() => asText(selectedRun?.summary?.commit_message), [selectedRun]);
  const narrativeSummary = useMemo(() => asText(llmSummary?.summary) || commitMessage, [llmSummary, commitMessage]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const runsResp = await apiJson<ImpactRunsResponse>(`/api/projects/${encodeURIComponent(projectId)}/impact-runs?limit=50&offset=0`);
      const nextRuns = runsResp.runs ?? [];
      setRuns(nextRuns);
      setSelectedRun((prev) => (prev ? nextRuns.find((run) => run.job_id === prev.job_id) ?? nextRuns[0] ?? null : nextRuns[0] ?? null));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("projectImpact.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setShowAllFiles(false);
    setShowAllFileFacts(false);
    setShowAllChangeFacts(false);
    setShowAllDirectImpacts(false);
    setShowAllRisks(false);
    setShowAllCrossSystemImpact(false);
    setShowAllVerificationFocus(false);
    setShowAllTests(false);
    setFileQuery("");
  }, [selectedRun?.job_id]);

  async function onRetry(jobId: string) {
    setRetryingJobId(jobId);
    setError(null);
    try {
      await apiJson(`/api/index-jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("projectImpact.retryFail"));
    } finally {
      setRetryingJobId(null);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="min-w-0 overflow-hidden border-0 shadow-sm ring-1 ring-border/70">
          <CardHeader className="border-b bg-muted/15 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <div className="flex size-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <GitCommitHorizontal className="size-4" aria-hidden />
                  </div>
                  <CardTitle className="text-sm">{t("projectImpact.runsTitle")}</CardTitle>
                </div>
                <CardDescription className="line-clamp-1 text-xs">Recent impact analysis runs.</CardDescription>
              </div>
              <Button variant="outline" size="icon" onClick={() => void load()} disabled={loading} className="size-8 shrink-0" aria-label={t("common.refresh")}>
                <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-2.5">
            {runs.length === 0 ? (
              <div className="rounded-xl border border-dashed px-4 py-10 text-sm text-muted-foreground">{t("projectImpact.empty")}</div>
            ) : (
              <div className="max-h-[72vh] space-y-2 overflow-auto pr-1">
                {runs.map((run) => {
                  const active = selectedRun?.job_id === run.job_id;
                  return (
                    <button
                      key={run.job_id}
                      type="button"
                      onClick={() => setSelectedRun(run)}
                      className={[
                        "group w-full rounded-xl border px-3 py-3 text-left transition-all",
                        active ? "border-primary/35 bg-primary/[0.06] shadow-sm" : "border-border/70 bg-background hover:border-primary/20 hover:bg-muted/25",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-1 text-sm font-medium text-foreground">{commitMessage && selectedRun?.job_id === run.job_id ? commitMessage : asText(run.summary?.commit_message) || "—"}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{shortSha(run.commit_sha)}</div>
                        </div>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${riskTone(run.risk_level)}`}>
                          {(run.risk_level || "unknown").toUpperCase()}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <GitBranch className="size-3 shrink-0" aria-hidden />
                          <span className="truncate">{run.branch || "—"}</span>
                        </div>
                        <span className="shrink-0">{formatDateTimeToSeconds(run.created_at)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden border-0 shadow-sm ring-1 ring-border/70">
          <CardHeader className="border-b px-5 py-4">
            {selectedRun ? (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1.5">
                  <CardTitle className="line-clamp-2 text-lg">{commitMessage || t("projectImpact.detailTitle")}</CardTitle>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{shortSha(selectedRun.commit_sha)}</span>
                    <span>{selectedRun.branch || "—"}</span>
                    <span>{formatDateTimeToSeconds(selectedRun.created_at)}</span>
                  </div>
                </div>
                <div className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${riskTone(selectedRun.risk_level)}`}>
                  {(selectedRun.risk_level || "unknown").toUpperCase()}
                </div>
              </div>
            ) : (
              <div>
                <CardTitle className="text-lg">{t("projectImpact.detailTitle")}</CardTitle>
                <CardDescription>{t("projectImpact.detailEmpty")}</CardDescription>
              </div>
            )}
          </CardHeader>

          <CardContent className="space-y-5 px-5 py-4 text-sm">
            {selectedRun ? (
              <>
                <section className="space-y-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Sparkles className="size-4 text-primary" aria-hidden />
                    {t("projectImpact.llmSummary")}
                  </div>
                  <div className="rounded-xl bg-muted/20 px-4 py-3 leading-6 text-foreground">
                    {narrativeSummary || "—"}
                  </div>
                </section>

                <div className="space-y-5">
                  <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                    <div className="space-y-5">
                      <section className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-foreground">{t("projectImpact.changedFiles")}</div>
                          <div className="text-xs text-muted-foreground">
                            {t("projectImpact.changedFilesCount", { count: String(changedFiles.length) })}
                          </div>
                        </div>

                        {changedFiles.length ? (
                          <div className="space-y-3">
                            <input
                              value={fileQuery}
                              onChange={(e) => setFileQuery(e.target.value)}
                              placeholder={t("projectImpact.fileSearchPlaceholder")}
                              aria-label={t("projectImpact.fileSearchAria")}
                              className="h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
                            />

                            {topDirectories.length ? (
                              <div className="space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("projectImpact.topDirectories")}</div>
                                  {fileQuery.trim() ? (
                                    <div className="text-[11px] text-muted-foreground">
                                      {t("projectImpact.filteredFilesCount", { count: String(filteredChangedFiles.length) })}
                                    </div>
                                  ) : null}
                                </div>
                                <TagList items={topDirectories} />
                              </div>
                            ) : null}

                            {filteredChangedFiles.length ? (
                              <>
                                <div className="max-h-[280px] space-y-2 overflow-auto pr-1">
                                  {visibleChangedFiles.map((file) => (
                                    <div key={file} className="rounded-lg border bg-muted/20 px-3 py-2 font-mono text-xs text-foreground">
                                      {file}
                                    </div>
                                  ))}
                                </div>
                                {filteredChangedFiles.length > DEFAULT_VISIBLE_FILES ? (
                                  <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                                    <span>
                                      {showAllFiles
                                        ? t("projectImpact.showingAllFiles")
                                        : t("projectImpact.hiddenFilesCount", { count: String(hiddenFileCount) })}
                                    </span>
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAllFiles((prev) => !prev)}>
                                      {showAllFiles ? t("projectImpact.collapseFiles") : t("projectImpact.showAllFiles")}
                                    </Button>
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              <div className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                                {t("projectImpact.fileSearchEmpty")}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </section>

                      <section className="space-y-3">
                        <div className="text-sm font-semibold text-foreground">{t("projectImpact.changedModules")}</div>
                        <TagList items={changedModules} />
                      </section>

                      <section className="space-y-3">
                        <div className="text-sm font-semibold text-foreground">{t("projectImpact.affectedAreas")}</div>
                        <TagList items={affectedAreas} />
                      </section>

                      <section className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-foreground">{t("projectImpact.fileFactsTitle")}</div>
                          <div className="text-xs text-muted-foreground">
                            {t("projectImpact.validationItemsCount", { count: String(fileFacts.length) })}
                          </div>
                        </div>
                        {fileFacts.length ? (
                          <div className="space-y-3">
                            {visibleFileFacts.map((item) => (
                              <div key={`${item.path}-${item.status}`} className="rounded-xl border bg-muted/10 p-4 space-y-3">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0 space-y-1">
                                    <div className="break-all font-mono text-xs text-foreground">{item.path}</div>
                                    {item.previous_path ? <div className="text-[11px] text-muted-foreground">from {item.previous_path}</div> : null}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                                    <span className={`rounded-full border px-2 py-0.5 font-medium ${fileStatusTone(item.status)}`}>{item.status}</span>
                                    <span className="text-muted-foreground">+{item.added}/-{item.deleted}</span>
                                    <span className={`font-semibold ${fileRiskTone(item.risk_score)}`}>risk {item.risk_score}</span>
                                  </div>
                                </div>
                                {item.file_role ? <div className="text-xs font-medium text-primary">{item.file_role}</div> : null}
                                {item.change_summary ? <div className="rounded-lg bg-background/70 px-3 py-2 text-sm text-foreground">{item.change_summary}</div> : null}
                                {item.impact_summary ? <div className="rounded-lg border border-amber-200/60 bg-amber-50/60 px-3 py-2 text-sm text-foreground dark:border-amber-900/40 dark:bg-amber-950/10">{item.impact_summary}</div> : null}
                                <TagList items={item.matched_categories} />
                                {item.evidence?.length ? <SectionList items={item.evidence} /> : item.facts.length ? <SectionList items={item.facts} /> : null}
                              </div>
                            ))}
                            {fileFacts.length > DEFAULT_VISIBLE_FILE_FACTS ? (
                              <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                                <span>
                                  {showAllFileFacts
                                    ? t("projectImpact.showingAllValidationItems")
                                    : t("projectImpact.hiddenValidationItemsCount", { count: String(hiddenFileFactsCount) })}
                                </span>
                                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAllFileFacts((prev) => !prev)}>
                                  {showAllFileFacts ? t("projectImpact.collapseValidationItems") : t("projectImpact.showAllValidationItems")}
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </section>

                      <section className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-foreground">{t("projectImpact.changeFacts")}</div>
                          <div className="text-xs text-muted-foreground">
                            {t("projectImpact.validationItemsCount", { count: String(changeFacts.length) })}
                          </div>
                        </div>
                        <SectionList items={visibleChangeFacts} />
                        {changeFacts.length > DEFAULT_VISIBLE_VALIDATION_ITEMS ? (
                          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                            <span>
                              {showAllChangeFacts
                                ? t("projectImpact.showingAllValidationItems")
                                : t("projectImpact.hiddenValidationItemsCount", { count: String(hiddenChangeFactsCount) })}
                            </span>
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAllChangeFacts((prev) => !prev)}>
                              {showAllChangeFacts ? t("projectImpact.collapseValidationItems") : t("projectImpact.showAllValidationItems")}
                            </Button>
                          </div>
                        ) : null}
                      </section>
                    </div>

                    <div className="space-y-5">
                      <section className="space-y-3">
                        <div className="text-sm font-semibold text-foreground">{t("projectImpact.directImpacts")}</div>
                        <SectionList items={visibleDirectImpacts} />
                        {directImpacts.length > DEFAULT_VISIBLE_RISKS ? (
                          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                            <span>
                              {showAllDirectImpacts
                                ? t("projectImpact.showingAllRisks")
                                : t("projectImpact.hiddenRisksCount", { count: String(hiddenDirectImpactsCount) })}
                            </span>
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAllDirectImpacts((prev) => !prev)}>
                              {showAllDirectImpacts ? t("projectImpact.collapseRisks") : t("projectImpact.showAllRisks")}
                            </Button>
                          </div>
                        ) : null}
                      </section>

                      <section className="space-y-3">
                        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <ShieldAlert className="size-4 text-amber-500" aria-hidden />
                          {t("projectImpact.risksAndImpact")}
                        </div>
                        <SectionList items={visibleRiskItems} />
                        {riskItems.length > DEFAULT_VISIBLE_RISKS ? (
                          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                            <span>
                              {showAllRisks
                                ? t("projectImpact.showingAllRisks")
                                : t("projectImpact.hiddenRisksCount", { count: String(hiddenRiskCount) })}
                            </span>
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAllRisks((prev) => !prev)}>
                              {showAllRisks ? t("projectImpact.collapseRisks") : t("projectImpact.showAllRisks")}
                            </Button>
                          </div>
                        ) : null}
                      </section>

                      <section className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-foreground">{t("projectImpact.crossSystemImpact")}</div>
                          <div className="text-xs text-muted-foreground">
                            {t("projectImpact.crossSystemImpactCount", { count: String(crossSystemImpact.length) })}
                          </div>
                        </div>
                        <SectionList items={visibleCrossSystemImpact} />
                        {crossSystemImpact.length > DEFAULT_VISIBLE_VALIDATION_ITEMS ? (
                          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                            <span>
                              {showAllCrossSystemImpact
                                ? t("projectImpact.showingAllCrossSystemImpact")
                                : t("projectImpact.hiddenCrossSystemImpactCount", { count: String(hiddenCrossSystemImpactCount) })}
                            </span>
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAllCrossSystemImpact((prev) => !prev)}>
                              {showAllCrossSystemImpact ? t("projectImpact.collapseCrossSystemImpact") : t("projectImpact.showAllCrossSystemImpact")}
                            </Button>
                          </div>
                        ) : null}
                      </section>

                      <section className="space-y-3">
                        <div className="text-sm font-semibold text-foreground">{t("projectImpact.verificationFocusTitle")}</div>
                        <SectionList items={visibleVerificationFocus} />
                        {verificationFocus.length > DEFAULT_VISIBLE_VALIDATION_ITEMS ? (
                          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                            <span>
                              {showAllVerificationFocus
                                ? t("projectImpact.showingAllValidationItems")
                                : t("projectImpact.hiddenValidationItemsCount", { count: String(hiddenVerificationFocusCount) })}
                            </span>
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAllVerificationFocus((prev) => !prev)}>
                              {showAllVerificationFocus ? t("projectImpact.collapseValidationItems") : t("projectImpact.showAllValidationItems")}
                            </Button>
                          </div>
                        ) : null}
                      </section>

                      <section className="space-y-4">
                        <div className="text-sm font-semibold text-foreground">{t("projectImpact.validationSuggestions")}</div>

                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("projectImpact.testSuggestionsTitle")}</div>
                            <div className="text-[11px] text-muted-foreground">{t("projectImpact.validationItemsCount", { count: String(tests.length) })}</div>
                          </div>
                          <StructuredSuggestionList items={visibleTests} />
                          {tests.length > DEFAULT_VISIBLE_VALIDATION_ITEMS ? (
                            <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                              <span>
                                {showAllTests
                                  ? t("projectImpact.showingAllValidationItems")
                                  : t("projectImpact.hiddenValidationItemsCount", { count: String(hiddenTestsCount) })}
                              </span>
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAllTests((prev) => !prev)}>
                                {showAllTests ? t("projectImpact.collapseValidationItems") : t("projectImpact.showAllValidationItems")}
                              </Button>
                            </div>
                          ) : null}
                        </div>

                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("projectImpact.suggestedReviewersTitle")}</div>
                            <div className="text-[11px] text-muted-foreground">{t("projectImpact.validationItemsCount", { count: String(reviewers.length) })}</div>
                          </div>
                          <ReviewerSuggestionList items={reviewers.map((item) => ({
                            label: `${t("projectImpact.reviewerPrefix")}${item.label}`,
                            detail: item.detail,
                          }))} />
                        </div>
                      </section>

                      <section className="space-y-3">
                        <div className="text-sm font-semibold text-foreground">{t("projectImpact.projectSnapshot")}</div>
                        <div className="space-y-3 rounded-xl border bg-muted/10 px-4 py-3">
                          <div className="text-sm text-foreground">
                            <span className="font-medium">{t("projectImpact.indexableFilesLabel")}</span>{" "}
                            <span className="text-muted-foreground">{totalIndexableFiles > 0 ? totalIndexableFiles : "—"}</span>
                          </div>
                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("projectImpact.topLevelAreas")}</div>
                            <TagList items={topLevelAreas} />
                          </div>
                        </div>
                      </section>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                  <Button variant="outline" onClick={() => void onRetry(selectedRun.job_id)} disabled={retryingJobId === selectedRun.job_id}>
                    {t("projectImpact.retry")}
                  </Button>
                  <Button asChild variant="outline">
                    <Link to="/jobs">{t("projectImpact.openJobs")}</Link>
                  </Button>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-dashed px-4 py-10 text-muted-foreground">{t("projectImpact.detailEmpty")}</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
