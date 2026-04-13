import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "@/i18n/I18nContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PAGE_SIZES, type Job } from "../types";

type JobsTableCardProps = {
  jobs: Job[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPageSizeChange: (size: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
};

export function JobsTableCard({
  jobs,
  total,
  page,
  pageSize,
  totalPages,
  onPageSizeChange,
  onPrevPage,
  onNextPage,
}: JobsTableCardProps) {
  const { t } = useI18n();

  return (
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
              jobs.map((job) => (
                <TableRow key={job.job_id}>
                  <TableCell className="w-[14rem] max-w-[14rem] truncate font-mono text-xs" title={job.job_id}>
                    {job.job_id}
                  </TableCell>
                  <TableCell className="min-w-0">
                    <div className="truncate font-medium" title={job.project_id}>
                      {job.project_id}
                    </div>
                    {job.project_name ? (
                      <div className="truncate text-xs text-muted-foreground" title={job.project_name ?? undefined}>
                        {job.project_name}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="w-36 max-w-36 whitespace-nowrap">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs",
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
                    {job.is_current ? <span className="ml-1 text-xs text-primary">{t("jobs.current")}</span> : null}
                  </TableCell>
                  <TableCell className="w-16 max-w-16 text-right tabular-nums">{job.progress}%</TableCell>
                  <TableCell className="w-44 max-w-44">
                    <div className="truncate text-xs text-muted-foreground" title={job.message || job.step}>
                      {job.step}
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
      </CardContent>
    </Card>
  );
}
