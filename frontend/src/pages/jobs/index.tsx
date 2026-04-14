import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";
import { JobsPageHeader } from "./components/JobsPageHeader";
import { JobsTableCard } from "./components/JobsTableCard";
import { type Job } from "./types";

export function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [pageVisible, setPageVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const requestSeqRef = useRef(0);
  const inflightControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inflightControllerRef.current?.abort();
    const controller = new AbortController();
    inflightControllerRef.current = controller;
    const currentSeq = requestSeqRef.current + 1;
    requestSeqRef.current = currentSeq;
    setError(null);
    setLoading(true);
    try {
      const offset = page * pageSize;
      const response = await apiFetch(`/api/index-jobs?limit=${pageSize}&offset=${offset}`, { signal: controller.signal });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const json = (await response.json()) as { message?: string; detail?: unknown };
          if (json?.message) message = json.message;
          else if (json?.detail) message = typeof json.detail === "string" ? json.detail : JSON.stringify(json.detail);
        } catch {
          /* ignore parse errors */
        }
        if (controller.signal.aborted) return;
        setError(message);
        setJobs([]);
        setTotal(0);
        return;
      }
      if (controller.signal.aborted) return;
      if (currentSeq !== requestSeqRef.current) return;
      const data = (await response.json()) as { total?: number; jobs: Job[] };
      const totalCount = typeof data.total === "number" ? data.total : (data.jobs?.length ?? 0);
      setTotal(totalCount);
      setJobs(data.jobs ?? []);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      if (currentSeq !== requestSeqRef.current) return;
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Request failed");
      }
    } finally {
      if (controller.signal.aborted) return;
      if (currentSeq !== requestSeqRef.current) return;
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    function onVisibilityChange() {
      setPageVisible(document.visibilityState === "visible");
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    void load();
    if (!autoRefresh || !pageVisible) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, load, pageVisible]);

  useEffect(
    () => () => {
      inflightControllerRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (total === 0) return;
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    if (page > maxPage) setPage(maxPage);
  }, [total, pageSize, page]);

  function onPageSizeChange(size: number) {
    setPageSize(size);
    setPage(0);
  }

  async function cancelJob(jobId: string) {
    setCancelError(null);
    setCancellingId(jobId);
    try {
      const res = await apiFetch(`/api/index-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const json = (await res.json()) as { detail?: unknown };
          if (json?.detail != null) {
            message = typeof json.detail === "string" ? json.detail : JSON.stringify(json.detail);
          }
        } catch {
          /* ignore */
        }
        setCancelError(message);
        return;
      }
      await load();
    } finally {
      setCancellingId(null);
    }
  }

  async function retryJob(jobId: string) {
    setRetryError(null);
    setRetryingId(jobId);
    try {
      const res = await apiFetch(`/api/index-jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const json = (await res.json()) as { detail?: unknown };
          if (json?.detail != null) {
            message = typeof json.detail === "string" ? json.detail : JSON.stringify(json.detail);
          }
        } catch {
          /* ignore */
        }
        setRetryError(message);
        return;
      }
      setPage(0);
      await load();
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <JobsPageHeader
        onRefresh={() => void load()}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        refreshing={loading}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {cancelError ? <p className="text-sm text-destructive">{cancelError}</p> : null}
      {retryError ? <p className="text-sm text-destructive">{retryError}</p> : null}
      <JobsTableCard
        jobs={jobs}
        loading={loading}
        total={total}
        page={page}
        pageSize={pageSize}
        totalPages={totalPages}
        onPageSizeChange={onPageSizeChange}
        onPrevPage={() => setPage((currentPage) => Math.max(0, currentPage - 1))}
        onNextPage={() => setPage((currentPage) => currentPage + 1)}
        cancellingJobId={cancellingId}
        retryingJobId={retryingId}
        onCancelJob={(id) => void cancelJob(id)}
        onRetryJob={(id) => void retryJob(id)}
      />
    </div>
  );
}
