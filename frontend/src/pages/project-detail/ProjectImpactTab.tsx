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
  const risk = String(value || "").trim().toLowerCase();
  if (risk === "high") return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300";
  if (risk === "medium") return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300";
  if (risk === "low") return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300";
  return "border-border bg-muted/40 text-muted-foreground";
}

export function ProjectImpactTab() {
  const { t } = useI18n();
  const { projectId = "" } = useParams();
  const [runs, setRuns] = useState<ImpactRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<ImpactRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const llmSummary = useMemo(() => {
    const value = selectedRun?.summary?.llm;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  }, [selectedRun]);

  const changedFiles = useMemo(() => asList(selectedRun?.summary?.changed_files), [selectedRun]);
  const impactScope = useMemo(() => asList(llmSummary?.impact_scope), [llmSummary]);
  const risks = useMemo(() => asList(llmSummary?.risks), [llmSummary]);
  const tests = useMemo(() => asList(llmSummary?.tests), [llmSummary]);
  const reviewers = useMemo(() => asList(llmSummary?.reviewers), [llmSummary]);
  const narrativeSummary = useMemo(() => asText(llmSummary?.summary) || asText(selectedRun?.summary?.commit_message), [llmSummary, selectedRun]);

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
    <div className="space-y-5">
      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="min-w-0 overflow-hidden border-0 shadow-sm ring-1 ring-border/70">
          <CardHeader className="border-b bg-muted/20 pb-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="flex size-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <GitCommitHorizontal className="size-4" aria-hidden />
                  </div>
                  <CardTitle className="text-base">{t("projectImpact.runsTitle")}</CardTitle>
                </div>
                <CardDescription>{t("projectImpact.desc")}</CardDescription>
              </div>
              <Button variant="outline" size="icon" onClick={() => void load()} disabled={loading} className="shrink-0" aria-label={t("common.refresh")}>
                <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-3">
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
                        "group w-full rounded-2xl border px-4 py-3 text-left transition-all",
                        active
                          ? "border-primary/40 bg-primary/[0.07] shadow-sm"
                          : "border-border/80 bg-background hover:border-primary/25 hover:bg-muted/35",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-foreground">{shortSha(run.commit_sha)}</div>
                          <div className="mt-1 line-clamp-1 text-xs font-medium text-foreground/80">
                            {asText(run.summary?.commit_message) || "—"}
                          </div>
                        </div>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${riskTone(run.risk_level)}`}>
                          {(run.risk_level || "unknown").toUpperCase()}
                        </span>
                      </div>
                      <div className="mt-3 flex items-end justify-between gap-3 text-xs text-muted-foreground">
                        <div className="flex min-w-0 items-center gap-2">
                          <GitBranch className="size-3.5 shrink-0" aria-hidden />
                          <span className="truncate">{run.branch || "—"}</span>
                        </div>
                        <span className="shrink-0 text-right">{formatDateTimeToSeconds(run.created_at)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden border-0 shadow-sm ring-1 ring-border/70">
          <CardHeader className="border-b bg-gradient-to-br from-muted/25 via-background to-background pb-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <CardTitle className="text-lg">{t("projectImpact.detailTitle")}</CardTitle>
                <CardDescription>{selectedRun?.job_id || t("projectImpact.detailEmpty")}</CardDescription>
              </div>
              {selectedRun ? (
                <div className={`rounded-full border px-3 py-1 text-xs font-semibold ${riskTone(selectedRun.risk_level)}`}>
                  {(selectedRun.risk_level || "unknown").toUpperCase()}
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-5 p-5 text-sm">
            {selectedRun ? (
              <>
                <div className="rounded-2xl border bg-card p-4 shadow-sm">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Sparkles className="size-4 text-primary" aria-hidden />
                    {t("projectImpact.llmSummary")}
                  </div>
                  <div className="rounded-xl bg-muted/25 px-4 py-3 text-sm leading-6 text-foreground">
                    {narrativeSummary || "—"}
                  </div>
                </div>

                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="rounded-2xl border bg-card p-4 shadow-sm">
                    <div className="mb-3 text-sm font-semibold text-foreground">{t("projectImpact.changedFiles")}</div>
                    {changedFiles.length ? (
                      <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
                        {changedFiles.map((file) => (
                          <div key={file} className="rounded-xl border bg-muted/20 px-3 py-2 font-mono text-xs text-foreground">
                            {file}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed px-3 py-6 text-sm text-muted-foreground">—</div>
                    )}
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-2xl border bg-card p-4 shadow-sm">
                      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                        <ShieldAlert className="size-4 text-amber-500" aria-hidden />
                        风险与影响
                      </div>
                      <div className="space-y-2">
                        {impactScope.map((item) => (
                          <div key={`scope-${item}`} className="rounded-xl bg-muted/20 px-3 py-2 text-sm text-foreground">
                            {item}
                          </div>
                        ))}
                        {risks.map((item) => (
                          <div key={`risk-${item}`} className="rounded-xl bg-muted/20 px-3 py-2 text-sm text-foreground">
                            {item}
                          </div>
                        ))}
                        {!impactScope.length && !risks.length ? <div className="rounded-xl border border-dashed px-3 py-6 text-sm text-muted-foreground">—</div> : null}
                      </div>
                    </div>

                    <div className="rounded-2xl border bg-card p-4 shadow-sm">
                      <div className="mb-3 text-sm font-semibold text-foreground">验证建议</div>
                      <div className="space-y-2">
                        {tests.map((item) => (
                          <div key={`test-${item}`} className="rounded-xl bg-muted/20 px-3 py-2 text-sm text-foreground">
                            {item}
                          </div>
                        ))}
                        {reviewers.map((item) => (
                          <div key={`reviewer-${item}`} className="rounded-xl bg-muted/20 px-3 py-2 text-sm text-foreground">
                            Reviewer: {item}
                          </div>
                        ))}
                        {!tests.length && !reviewers.length ? <div className="rounded-xl border border-dashed px-3 py-6 text-sm text-muted-foreground">—</div> : null}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
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
