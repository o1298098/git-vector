import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nContext";

type Job = {
  job_id: string;
  project_id: string;
  project_name: string | null;
  status: string;
  progress: number;
  step: string;
  message: string;
  is_current: boolean;
};

const PAGE_SIZES = [10, 20, 50] as const;

export function Jobs() {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [err, setErr] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);

  const load = useCallback(async () => {
    setErr(null);
    const offset = page * pageSize;
    const res = await apiFetch(`/api/index-jobs?limit=${pageSize}&offset=${offset}`);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      } catch {
        /* ignore */
      }
      setErr(msg);
      setJobs([]);
      setTotal(0);
      return;
    }
    const data = (await res.json()) as { total?: number; jobs: Job[] };
    const totalCount = typeof data.total === "number" ? data.total : (data.jobs?.length ?? 0);
    setTotal(totalCount);
    setJobs(data.jobs ?? []);
  }, [page, pageSize]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (total === 0) return;
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    if (page > maxPage) setPage(maxPage);
  }, [total, pageSize, page]);

  function onPageSizeChange(s: number) {
    setPageSize(s);
    setPage(0);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("jobs.title")}</h1>
          <p className="text-muted-foreground">{t("jobs.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {t("jobs.refresh")}
        </Button>
      </div>

      {err ? <p className="text-sm text-destructive">{err}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("jobs.cardTitle")}</CardTitle>
          <CardDescription>
            {t("jobs.cardDesc")}{" "}
            <Link to="/enqueue" className="text-primary underline-offset-4 hover:underline">
              {t("jobs.newIndex")}
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[14rem]">{t("jobs.colJobId")}</TableHead>
                <TableHead className="min-w-0">{t("jobs.colProject")}</TableHead>
                <TableHead className="w-36">{t("jobs.colStatus")}</TableHead>
                <TableHead className="w-16 text-right">{t("jobs.colProgress")}</TableHead>
                <TableHead className="w-44">{t("jobs.colStep")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    {t("jobs.empty")}
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((j) => (
                  <TableRow key={j.job_id}>
                    <TableCell className="w-[14rem] max-w-[14rem] truncate font-mono text-xs" title={j.job_id}>
                      {j.job_id}
                    </TableCell>
                    <TableCell className="min-w-0">
                      <div className="truncate font-medium" title={j.project_id}>
                        {j.project_id}
                      </div>
                      {j.project_name ? (
                        <div className="truncate text-xs text-muted-foreground" title={j.project_name ?? undefined}>
                          {j.project_name}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="w-36 max-w-36 whitespace-nowrap">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs",
                          j.status === "succeeded" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
                          j.status === "failed" && "bg-destructive/15 text-destructive",
                          j.status === "cancelled" && "bg-orange-500/15 text-orange-700 dark:text-orange-400",
                          j.status === "running" && "bg-primary/15 text-primary",
                          !["succeeded", "failed", "cancelled", "running"].includes(j.status) &&
                            "bg-secondary text-secondary-foreground",
                        )}
                      >
                        {j.status}
                      </span>
                      {j.is_current ? (
                        <span className="ml-1 text-xs text-primary">{t("jobs.current")}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="w-16 max-w-16 text-right tabular-nums">{j.progress}%</TableCell>
                    <TableCell className="w-44 max-w-44">
                      <div className="truncate text-xs text-muted-foreground" title={j.message || j.step}>
                        {j.step}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {t("jobs.pageInfo", { total: String(total) })}
              {total > 0 ? t("jobs.pageNav", { cur: String(page + 1), all: String(totalPages) }) : null}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                {t("jobs.perPage")}
                <select
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={pageSize}
                  onChange={(e) => onPageSizeChange(Number(e.target.value))}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                {t("jobs.rows")}
              </label>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="size-4" />
                  {t("jobs.prev")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page + 1 >= totalPages || total === 0}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("jobs.next")}
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
