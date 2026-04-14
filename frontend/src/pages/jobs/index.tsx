import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { JobsPageHeader } from "./components/JobsPageHeader";
import { JobsTableCard } from "./components/JobsTableCard";
import { type Job } from "./types";

export function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);

  const load = useCallback(async () => {
    setError(null);
    const offset = page * pageSize;
    const response = await apiFetch(`/api/index-jobs?limit=${pageSize}&offset=${offset}`);
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const json = await response.json();
        if (json?.detail) message = typeof json.detail === "string" ? json.detail : JSON.stringify(json.detail);
      } catch {
        /* ignore parse errors */
      }
      setError(message);
      setJobs([]);
      setTotal(0);
      return;
    }
    const data = (await response.json()) as { total?: number; jobs: Job[] };
    const totalCount = typeof data.total === "number" ? data.total : (data.jobs?.length ?? 0);
    setTotal(totalCount);
    setJobs(data.jobs ?? []);
  }, [page, pageSize]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

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
      <JobsPageHeader onRefresh={() => void load()} />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {cancelError ? <p className="text-sm text-destructive">{cancelError}</p> : null}
      {retryError ? <p className="text-sm text-destructive">{retryError}</p> : null}
      <JobsTableCard
        jobs={jobs}
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
