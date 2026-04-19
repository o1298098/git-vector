import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { apiJson } from "@/lib/api";
import { useI18n } from "@/i18n/I18nContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PAGE_SIZES, type Job, type JobLogsResponse } from "../types";

type JobsTableCardProps = {
  jobs: Job[];
  loading: boolean;
  /** After first request finishes (success or error); avoids skeleton flashing on empty-list polling. */
  initialFetchDone: boolean;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPageSizeChange: (size: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  cancellingJobId: string | null;
  retryingJobId: string | null;
  onCancelJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
};

function parseTime(value?: string | null): number | null {
  if (!value) return null;
  const n = Date.parse(value);
  return Number.isNaN(n) ? null : n;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getJobDuration(job: Job): string {
  const createdAt = parseTime(job.created_at);
  const startedAt = parseTime(job.started_at);
  const finishedAt = parseTime(job.finished_at);
  const start = startedAt ?? createdAt;
  if (start == null) return "—";
  const end = finishedAt ?? Date.now();
  if (end <= start) return "—";
  return formatDuration(end - start);
}

function formatLogTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function stripRepeatedStepPrefix(message: string, step?: string | null): string {
  const text = String(message || "");
  const stepText = String(step || "").trim();
  if (!stepText) return text;
  const prefix = `${stepText}: `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

export function JobsTableCard({
  jobs,
  loading,
  initialFetchDone,
  total,
  page,
  pageSize,
  totalPages,
  onPageSizeChange,
  onPrevPage,
  onNextPage,
  cancellingJobId,
  retryingJobId,
  onCancelJob,
  onRetryJob,
}: JobsTableCardProps) {
  const { t } = useI18n();
  const [detailJobId, setDetailJobId] = useState<string | null>(null);
  const [detailLogs, setDetailLogs] = useState<JobLogsResponse["logs"]>([]);
  const [detailLogsLoading, setDetailLogsLoading] = useState(false);
  const [detailLogsError, setDetailLogsError] = useState<string | null>(null);
  const closeDetailBtnRef = useRef<HTMLButtonElement | null>(null);
  const detailDialogRef = useRef<HTMLDivElement | null>(null);
  const detailLogViewportRef = useRef<HTMLPreElement | null>(null);
  const lastDetailLogCountRef = useRef(0);
  const detailJob = useMemo(() => jobs.find((j) => j.job_id === detailJobId) ?? null, [jobs, detailJobId]);
  const detailTitle = useMemo(() => {
    if (!detailJob) return "";
    return detailJob.project_name?.trim() || detailJob.project_id?.trim() || detailJob.job_id;
  }, [detailJob]);
  const detailJobRunning = detailJob?.status === "running";
  const showInitialSkeleton = loading && jobs.length === 0 && !initialFetchDone;
  const showSoftRefresh = loading && jobs.length > 0;

  useEffect(() => {
    if (!detailJob) return;
    const prevActive = document.activeElement as HTMLElement | null;
    closeDetailBtnRef.current?.focus();
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        setDetailJobId(null);
        return;
      }
      if (ev.key !== "Tab") return;
      const dialog = detailDialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      prevActive?.focus();
    };
  }, [detailJob]);

  useEffect(() => {
    if (!detailJobId) {
      setDetailLogs([]);
      setDetailLogsError(null);
      setDetailLogsLoading(false);
      lastDetailLogCountRef.current = 0;
      return;
    }

    let cancelled = false;

    const loadLogs = (isInitialLoad: boolean) => {
      if (isInitialLoad) {
        setDetailLogsLoading(true);
      }
      setDetailLogsError(null);
      void apiJson<JobLogsResponse>(`/api/index-jobs/${encodeURIComponent(detailJobId)}/logs?limit=1000&offset=0`)
        .then((response) => {
          if (cancelled) return;
          setDetailLogs(response.logs ?? []);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setDetailLogs([]);
          setDetailLogsError(error instanceof Error ? error.message : "Failed to load logs");
        })
        .finally(() => {
          if (cancelled || !isInitialLoad) return;
          setDetailLogsLoading(false);
        });
    };

    loadLogs(true);
    const timer =
      detailJobRunning
        ? window.setInterval(() => {
            loadLogs(false);
          }, 2000)
        : null;

    return () => {
      cancelled = true;
      if (timer != null) {
        window.clearInterval(timer);
      }
    };
  }, [detailJobId, detailJobRunning]);

  useEffect(() => {
    const currentCount = detailLogs.length;
    const previousCount = lastDetailLogCountRef.current;
    lastDetailLogCountRef.current = currentCount;

    if (!detailJob || detailJob.status !== "running") return;
    if (currentCount <= previousCount) return;

    const viewport = detailLogViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [detailJob, detailLogs]);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="relative">
          <div
            className={cn(
              "w-full overflow-x-auto transition-opacity duration-300 ease-out",
              showSoftRefresh ? "opacity-[0.93]" : "opacity-100",
            )}
            aria-busy={showSoftRefresh}
          >
            <Table className="!w-full min-w-[75.5rem] table-fixed text-xs">
              <colgroup>
                <col style={{ width: "13rem" }} />
                <col style={{ width: "17rem" }} />
                <col style={{ width: "8rem" }} />
                <col style={{ width: "9rem" }} />
                <col style={{ width: "5rem" }} />
                <col style={{ width: "7.5rem" }} />
                <col style={{ width: "6.5rem" }} />
                <col style={{ width: "9rem" }} />
              </colgroup>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 whitespace-nowrap px-2 py-1.5 align-bottom text-[11px]">
                    {t("jobs.colJobId")}
                  </TableHead>
                  <TableHead className="h-8 whitespace-nowrap px-2 py-1.5 align-bottom text-[11px]">
                    {t("jobs.colProject")}
                  </TableHead>
                  <TableHead className="h-8 whitespace-nowrap px-2 py-1.5 align-bottom text-[11px]">
                    {t("jobs.colStatus")}
                  </TableHead>
                  <TableHead className="h-8 whitespace-nowrap px-2 py-1.5 align-bottom text-[11px]">
                    {t("jobs.colType")}
                  </TableHead>
                  <TableHead className="h-8 whitespace-nowrap px-2 py-1.5 align-bottom text-right text-[11px]">
                    {t("jobs.colProgress")}
                  </TableHead>
                  <TableHead className="h-8 whitespace-nowrap px-2 py-1.5 align-bottom text-[11px]">
                    {t("jobs.colStep")}
                  </TableHead>
                  <TableHead className="h-8 whitespace-nowrap px-2 py-1.5 align-bottom text-right text-[11px]">
                    {t("jobs.colDuration")}
                  </TableHead>
                  <TableHead className="h-8 whitespace-nowrap px-2 py-1.5 align-bottom text-right text-[11px]">
                    {t("jobs.colActions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {showInitialSkeleton ? (
                  Array.from({ length: 9 }).map((_, index) => (
                    <TableRow key={`skeleton-${index}`} className="leading-tight">
                      <TableCell className="px-2 py-1.5">
                        <div className="h-3 w-[92%] animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <div className="h-3 w-[78%] animate-pulse rounded bg-muted" />
                        <div className="mt-1.5 h-3 w-[52%] animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <div className="ml-auto h-3 w-10 animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <div className="ml-auto h-3 w-12 animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <div className="ml-auto h-7 w-14 animate-pulse rounded bg-muted" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : jobs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-2 text-muted-foreground">
                      {t("jobs.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  jobs.map((job) => (
                    <TableRow key={job.job_id} className="leading-tight">
                      <TableCell className="align-top px-2 py-1.5 font-mono text-[10px] leading-snug text-foreground break-all [width:19rem]">
                        <span title={job.job_id}>{job.job_id}</span>
                      </TableCell>
                      <TableCell className="min-w-0 align-top px-2 py-1.5 [width:20rem]">
                        <div className="truncate text-xs font-medium" title={job.project_id}>
                          {job.project_id}
                        </div>
                        {job.project_name ? (
                          <div className="truncate text-[11px] text-muted-foreground" title={job.project_name ?? undefined}>
                            {job.project_name}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top px-2 py-1.5 whitespace-nowrap [width:8rem]">
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2 py-1 text-[10px] font-medium",
                            job.status === "succeeded" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
                            job.status === "failed" && "bg-destructive/15 text-destructive",
                            job.status === "cancelled" && "bg-orange-500/15 text-orange-700 dark:text-orange-400",
                            job.status === "running" && "bg-primary/15 text-primary",
                            !["succeeded", "failed", "cancelled", "running"].includes(job.status) &&
                              "bg-secondary text-secondary-foreground",
                          )}
                        >
                          {job.status}
                        </span>
                        {job.is_current ? (
                          <span className="mt-0.5 block text-[10px] text-primary md:mt-0 md:ml-1 md:inline">
                            {t("jobs.current")}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top px-2 py-1.5 whitespace-nowrap [width:9rem]">
                        <span className="inline-flex rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">
                          {job.job_type || "index"}
                        </span>
                      </TableCell>
                      <TableCell className="align-top px-2 py-1.5 text-right tabular-nums text-xs [width:5rem]">
                        {job.progress}%
                      </TableCell>
                      <TableCell className="min-w-0 align-top px-2 py-1.5 [width:7.5rem]">
                        <div
                          className="truncate whitespace-nowrap text-[11px] text-muted-foreground"
                          title={[job.step, job.message].filter(Boolean).join(" — ")}
                        >
                          {job.step}
                        </div>
                      </TableCell>
                      <TableCell className="align-top px-2 py-1.5 text-right tabular-nums text-[11px] text-muted-foreground [width:6.5rem]">
                        {getJobDuration(job)}
                      </TableCell>
                      <TableCell className="align-top px-2 py-1.5 text-right [width:9rem]">
                        <div className="flex flex-wrap justify-end gap-1">
                          {job.status === "queued" || job.status === "running" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                              disabled={cancellingJobId === job.job_id}
                              onClick={() => onCancelJob(job.job_id)}
                            >
                              {cancellingJobId === job.job_id ? t("jobs.cancelling") : t("jobs.cancel")}
                            </Button>
                          ) : null}
                          {(job.status === "failed" || job.status === "cancelled") && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              disabled={retryingJobId === job.job_id}
                              onClick={() => onRetryJob(job.job_id)}
                            >
                              {retryingJobId === job.job_id ? t("jobs.retrying") : t("jobs.retry")}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setDetailJobId(job.job_id)}
                          >
                            {t("jobs.detail")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {t("jobs.pageInfo", { total: String(total) })}
            {total > 0 ? t("jobs.pageNav", { cur: String(page + 1), all: String(totalPages) }) : null}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t("jobs.perPage")}
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={pageSize}
                onChange={(event) => onPageSizeChange(Number(event.target.value))}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
              {t("jobs.rows")}
            </label>
            <div className="flex items-center gap-1">
              <Button type="button" variant="outline" size="sm" disabled={page <= 0} onClick={onPrevPage}>
                <ChevronLeft className="size-4" />
                {t("jobs.prev")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page + 1 >= totalPages || total === 0}
                onClick={onNextPage}
              >
                {t("jobs.next")}
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        {detailJob ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="job-detail-title"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setDetailJobId(null);
            }}
          >
            <div ref={detailDialogRef} className="w-full max-w-3xl rounded-lg border bg-background shadow-xl">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h3 id="job-detail-title" className="text-sm font-semibold">
                  {t("jobs.detail")} · {detailTitle}
                </h3>
                <Button
                  ref={closeDetailBtnRef}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDetailJobId(null)}
                >
                  {t("jobs.closeDetail")}
                </Button>
              </div>
              <div className="space-y-3 p-4 text-sm">
                {detailJob.failure_reason ? (
                  <p className="whitespace-pre-wrap break-words rounded border border-destructive/40 bg-destructive/5 p-3 text-destructive">
                    {detailJob.failure_reason}
                  </p>
                ) : null}

                <div className="grid gap-2 rounded-md border bg-muted/10 p-3 text-xs sm:grid-cols-2">
                  <div>
                    <div className="text-muted-foreground">{t("jobs.detailType")}</div>
                    <div className="font-medium text-foreground">{detailJob.job_type || "index"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">{t("jobs.detailStatus")}</div>
                    <div className="font-medium text-foreground">{detailJob.status}</div>
                  </div>
                  {detailJob.result && Object.keys(detailJob.result).length > 0 ? (
                    <div className="sm:col-span-2">
                      <div className="text-muted-foreground">{t("jobs.detailResult")}</div>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-2 font-mono text-[11px] text-muted-foreground">
                        {JSON.stringify(detailJob.result, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                </div>

                <div className="text-xs font-medium text-foreground">Execution Logs</div>
                {detailLogsLoading ? (
                  <p className="text-xs text-muted-foreground">Loading logs...</p>
                ) : detailLogsError ? (
                  <p className="whitespace-pre-wrap break-words text-xs text-destructive">{detailLogsError}</p>
                ) : detailLogs.length > 0 ? (
                  <pre
                    ref={detailLogViewportRef}
                    className="max-h-[56vh] overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/20 p-3 font-mono text-xs text-muted-foreground"
                  >
                    {detailLogs
                      .map((log) => {
                        const timePart = `[${formatLogTimestamp(log.created_at)}]`;
                        const levelPart = `[${log.level}]`;
                        const stepPart = log.step ? `[${log.step}]` : "";
                        const message = stripRepeatedStepPrefix(log.message, log.step);
                        return `${timePart}${levelPart}${stepPart} ${message}`.trim();
                      })
                      .join("\n")}
                  </pre>
                ) : detailJob.log_excerpt ? (
                  <pre className="max-h-[56vh] overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/20 p-3 font-mono text-xs text-muted-foreground">
                    {detailJob.log_excerpt}
                  </pre>
                ) : (
                  <p className="text-xs text-muted-foreground">No logs yet.</p>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
