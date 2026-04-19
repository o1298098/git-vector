import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertCircle, GitBranch, GitCommitHorizontal, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";
import type { ImpactRun, ImpactRunsResponse } from "./types";

function shortSha(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text) return "—";
  return text.length > 8 ? text.slice(0, 8) : text;
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
    return <div className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">—</div>;
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
  const riskItems = useMemo(() => [...impactScope, ...risks], [impactScope, risks]);
  const visibleRiskItems = useMemo(() => (showAllRisks ? riskItems : riskItems.slice(0, DEFAULT_VISIBLE_RISKS)), [riskItems, showAllRisks]);
  const hiddenRiskCount = Math.max(0, riskItems.length - visibleRiskItems.length);
  const tests = useMemo(() => asList(llmSummary?.tests), [llmSummary]);
  const visibleTests = useMemo(() => (showAllTests ? tests : tests.slice(0, DEFAULT_VISIBLE_VALIDATION_ITEMS)), [showAllTests, tests]);
  const hiddenTestsCount = Math.max(0, tests.length - visibleTests.length);
  const reviewers = useMemo(() => asList(llmSummary?.reviewers), [llmSummary]);
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
                      ) : (
                        <div className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">—</div>
                      )}
                    </section>

                    <section className="space-y-3">
                      <div className="text-sm font-semibold text-foreground">{t("projectImpact.changedModules")}</div>
                      <TagList items={changedModules} />
                    </section>

                    <section className="space-y-3">
                      <div className="text-sm font-semibold text-foreground">{t("projectImpact.affectedAreas")}</div>
                      <TagList items={affectedAreas} />
                    </section>
                  </div>

                  <div className="space-y-5">
                    <section className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <ShieldAlert className="size-4 text-amber-500" aria-hidden />
                          {t("projectImpact.risksAndImpact")}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t("projectImpact.risksCount", { count: String(riskItems.length) })}
                        </div>
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

                    <section className="space-y-4">
                      <div className="text-sm font-semibold text-foreground">{t("projectImpact.validationSuggestions")}</div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("projectImpact.verificationFocusTitle")}</div>
                          <div className="text-[11px] text-muted-foreground">{t("projectImpact.validationItemsCount", { count: String(verificationFocus.length) })}</div>
                        </div>
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
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("projectImpact.testSuggestionsTitle")}</div>
                          <div className="text-[11px] text-muted-foreground">{t("projectImpact.validationItemsCount", { count: String(tests.length) })}</div>
                        </div>
                        <SectionList items={visibleTests} />
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
                        <TagList items={reviewers.map((item) => `${t("projectImpact.reviewerPrefix")}${item}`)} />
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
