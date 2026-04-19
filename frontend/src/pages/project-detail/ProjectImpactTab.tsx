import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { GitCommitHorizontal, RefreshCw } from "lucide-react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";
import type { ImpactRun, ImpactRunsResponse, ProjectSummary } from "./types";

export function ProjectImpactTab() {
  const { t } = useI18n();
  const { projectId = "" } = useParams();
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [runs, setRuns] = useState<ImpactRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<ImpactRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const llmSummary = useMemo(() => {
    const value = selectedRun?.summary?.llm;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  }, [selectedRun]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [summaryResp, runsResp] = await Promise.all([
        apiJson<ProjectSummary>(`/api/projects/${encodeURIComponent(projectId)}/summary`),
        apiJson<ImpactRunsResponse>(`/api/projects/${encodeURIComponent(projectId)}/impact-runs?limit=50&offset=0`),
      ]);
      setSummary(summaryResp);
      setRuns(runsResp.runs ?? []);
      setSelectedRun((prev) => (prev ? (runsResp.runs ?? []).find((run) => run.job_id === prev.job_id) ?? null : runsResp.runs?.[0] ?? null));
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
    <div className="space-y-4">
      {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div> : null}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border bg-background px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{t("projectImpact.metaLastCommit")}</div>
          <div className="mt-1 break-all text-sm font-semibold">{summary?.last_analyzed_commit || "—"}</div>
        </div>
        <div className="rounded-xl border bg-background px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{t("projectImpact.metaLastRisk")}</div>
          <div className="mt-1 text-sm font-semibold">{summary?.latest_impact?.risk_level || "—"}</div>
        </div>
        <div className="rounded-xl border bg-background px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{t("projectImpact.metaRepoPath")}</div>
          <div className="mt-1 break-all text-sm font-semibold">{summary?.last_local_repo_path || "—"}</div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="min-w-0 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <div className="flex items-center gap-2">
                <GitCommitHorizontal className="size-5 text-primary" aria-hidden />
                <CardTitle className="text-base">{t("projectImpact.runsTitle")}</CardTitle>
              </div>
              <CardDescription>{t("projectImpact.desc")}</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="size-4" aria-hidden />
              {t("common.refresh")}
            </Button>
          </CardHeader>
          <CardContent className="max-h-[70vh] space-y-2 overflow-auto">
            {runs.length === 0 ? (
              <div className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">{t("projectImpact.empty")}</div>
            ) : (
              runs.map((run) => (
                <button
                  key={run.job_id}
                  type="button"
                  onClick={() => setSelectedRun(run)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${selectedRun?.job_id === run.job_id ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
                >
                  <div className="truncate text-sm font-medium">{run.commit_sha || run.job_id}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>{run.branch || "—"}</span>
                    <span>·</span>
                    <span>{run.risk_level || "—"}</span>
                    <span>·</span>
                    <span>{run.created_at || "—"}</span>
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">{t("projectImpact.detailTitle")}</CardTitle>
            <CardDescription>{selectedRun?.job_id || t("projectImpact.detailEmpty")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {selectedRun ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border bg-muted/10 px-3 py-2">
                    <div className="text-xs text-muted-foreground">{t("projectImpact.detailRisk")}</div>
                    <div className="mt-1 font-medium">{selectedRun.risk_level || "—"}</div>
                  </div>
                  <div className="rounded-lg border bg-muted/10 px-3 py-2">
                    <div className="text-xs text-muted-foreground">{t("projectImpact.detailBranch")}</div>
                    <div className="mt-1 font-medium">{selectedRun.branch || "—"}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="text-sm font-medium">{t("projectImpact.changedFiles")}</div>
                  <div className="max-h-[24vh] overflow-auto rounded-xl border bg-muted/10 px-3 py-3 whitespace-pre-wrap text-sm text-foreground">
                    {JSON.stringify(selectedRun.summary?.changed_files ?? [], null, 2)}
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="text-sm font-medium">{t("projectImpact.llmSummary")}</div>
                  <div className="max-h-[34vh] overflow-auto rounded-xl border bg-muted/10 px-3 py-3 whitespace-pre-wrap text-sm text-foreground">
                    {JSON.stringify(llmSummary ?? selectedRun.summary, null, 2)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => void onRetry(selectedRun.job_id)} disabled={retryingJobId === selectedRun.job_id}>
                    {t("projectImpact.retry")}
                  </Button>
                  <Button asChild variant="outline">
                    <Link to="/jobs">{t("projectImpact.openJobs")}</Link>
                  </Button>
                </div>
              </>
            ) : (
              <div className="rounded-md border border-dashed px-4 py-6 text-muted-foreground">{t("projectImpact.detailEmpty")}</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
