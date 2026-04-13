import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, ExternalLink, MessageCircle, RefreshCw, Search, Trash2 } from "lucide-react";
import { apiJson } from "@/lib/api";
import { safeProjectId } from "@/lib/projectId";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

type ProjectRow = {
  project_id: string;
  doc_count: number;
  project_name?: string | null;
  created_at?: string | null;
  repo_url?: string | null;
};

function formatProjectCreatedAt(iso: string | null | undefined): string {
  const s = (iso ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

const PAGE_SIZES = [10, 20, 50] as const;
const SEARCH_DEBOUNCE_MS = 350;

/** 概览快捷入口：统一为 outline 形（边框+阴影+高度），仅用颜色区分 */
const dashboardActionClass =
  "h-9 min-w-[8.5rem] justify-center px-4 shadow-sm transition-colors";

export function Dashboard() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reindexingId, setReindexingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectRow | null>(null);
  const [reindexTarget, setReindexTarget] = useState<ProjectRow | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(0);
  }, [debouncedQ]);

  const load = useCallback(async () => {
    setErr(null);
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(page * pageSize),
    });
    if (debouncedQ) params.set("q", debouncedQ);
    try {
      const data = await apiJson<{ total?: number; projects: ProjectRow[] }>(`/api/projects?${params}`);
      const t = typeof data.total === "number" ? data.total : (data.projects?.length ?? 0);
      setTotal(t);
      setProjects(data.projects ?? []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("search.loadFail"));
      setProjects([]);
      setTotal(0);
    }
  }, [page, pageSize, debouncedQ, t]);


  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (total === 0) return;
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    if (page > maxPage) setPage(maxPage);
  }, [total, pageSize, page]);

  function onPageSizeChange(n: number) {
    setPageSize(n);
    setPage(0);
  }

  async function performDelete(p: ProjectRow) {
    setDeletingId(p.project_id);
    setErr(null);
    try {
      await apiJson<{ ok?: boolean }>(
        `/api/projects/${encodeURIComponent(p.project_id)}`,
        { method: "DELETE" },
      );
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("dashboard.deleteFail"));
    } finally {
      setDeletingId(null);
    }
  }

  async function performReindex(p: ProjectRow) {
    setReindexingId(p.project_id);
    setErr(null);
    try {
      await apiJson<{ status: string; job_id: string }>(
        `/api/projects/${encodeURIComponent(p.project_id)}/reindex`,
        { method: "POST" },
      );
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("dashboard.reindexFail"));
    } finally {
      setReindexingId(null);
      await load();
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("dashboard.title")}</h1>
        <p className="text-muted-foreground">{t("dashboard.subtitle")}</p>
      </div>

      {err ? <p className="text-sm text-destructive">{err}</p> : null}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle>{t("dashboard.semanticTitle")}</CardTitle>
            <CardDescription>{t("dashboard.semanticDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button
              asChild
              variant="outline"
              className={cn(
                dashboardActionClass,
                "border-primary/45 text-primary hover:bg-primary/10 hover:text-primary",
              )}
            >
              <Link to="/search">{t("dashboard.openSearch")}</Link>
            </Button>
          </CardContent>
        </Card>
        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="size-4 shrink-0" aria-hidden />
              {t("dashboard.chatTitle")}
            </CardTitle>
            <CardDescription>{t("dashboard.chatDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button
              asChild
              variant="outline"
              className={cn(
                dashboardActionClass,
                "border-sky-500/45 text-sky-700 hover:bg-sky-500/10 hover:text-sky-800 dark:border-sky-400/40 dark:text-sky-300 dark:hover:bg-sky-950/60 dark:hover:text-sky-200",
              )}
            >
              <Link to="/chat">{t("dashboard.openChat")}</Link>
            </Button>
          </CardContent>
        </Card>
        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle>{t("dashboard.jobsTitle")}</CardTitle>
            <CardDescription>{t("dashboard.jobsDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button
              asChild
              variant="outline"
              className={cn(
                dashboardActionClass,
                "border-border text-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Link to="/jobs">{t("dashboard.openJobs")}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("dashboard.projectsTitle")}</CardTitle>
          <CardDescription>{t("dashboard.projectsDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-md">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder={t("dashboard.searchPlaceholder")}
              className="pl-9"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="搜索项目"
            />
          </div>

          <Table className="table-fixed">
            <colgroup>
              <col className="w-60" />
              <col />
              <col className="w-44" />
              <col className="w-20" />
              <col className="w-36" />
              <col className="w-36" />
              <col className="w-28" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="align-middle">{t("dashboard.colProjectId")}</TableHead>
                <TableHead className="min-w-0 align-middle">{t("dashboard.colProjectName")}</TableHead>
                <TableHead className="whitespace-nowrap align-middle">{t("dashboard.colCreatedAt")}</TableHead>
                <TableHead className="whitespace-nowrap text-right align-middle">{t("dashboard.colVectors")}</TableHead>
                <TableHead className="align-middle">{t("dashboard.colRepo")}</TableHead>
                <TableHead className="align-middle">{t("dashboard.colWiki")}</TableHead>
                <TableHead className="whitespace-nowrap text-center align-middle">{t("dashboard.colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">
                    {debouncedQ ? t("dashboard.emptyFiltered") : t("dashboard.empty")}
                  </TableCell>
                </TableRow>
              ) : (
                projects.map((p) => {
                  const displayName = p.project_name?.trim() ? p.project_name : t("dashboard.dash");
                  return (
                  <TableRow key={p.project_id}>
                    <TableCell className="font-mono text-sm">
                      <Link
                        to={`/vectors?project_id=${encodeURIComponent(p.project_id)}`}
                        className="block truncate text-primary hover:underline"
                        title={`${t("nav.vectors")}: ${p.project_id}`}
                      >
                        {p.project_id}
                      </Link>
                    </TableCell>
                    <TableCell className="min-w-0 text-sm text-muted-foreground">
                      <Link
                        to={`/vectors?project_id=${encodeURIComponent(p.project_id)}`}
                        className="block truncate hover:text-foreground hover:underline"
                        title={displayName === t("dashboard.dash") ? undefined : `${t("nav.vectors")}: ${displayName}`}
                      >
                        {displayName}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatProjectCreatedAt(p.created_at) || t("dashboard.dash")}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">{p.doc_count}</TableCell>
                    <TableCell>
                      {p.repo_url ? (
                        <Button variant="outline" size="sm" className="h-8 w-full max-w-full justify-center gap-1 px-2" asChild>
                          <a href={p.repo_url} target="_blank" rel="noreferrer">
                            <span className="truncate">{t("dashboard.openRepo")}</span>
                            <ExternalLink className="size-3 shrink-0" />
                          </a>
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t("dashboard.dash")}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" className="h-8 w-full max-w-full justify-center gap-1 px-2" asChild>
                        <a href={`/wiki/${safeProjectId(p.project_id)}/site/`} target="_blank" rel="noreferrer">
                          <span className="truncate">{t("dashboard.openWiki")}</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      </Button>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-9 text-primary hover:bg-primary/10 hover:text-primary"
                          disabled={deletingId !== null || reindexingId !== null}
                          aria-label={`${t("dashboard.reindex")}: ${p.project_id}`}
                          onClick={() => setReindexTarget(p)}
                        >
                          <RefreshCw
                            className={cn(
                              "size-4",
                              reindexingId === p.project_id && "animate-spin",
                              reindexingId !== null && reindexingId !== p.project_id && "opacity-40",
                            )}
                          />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={deletingId !== null || reindexingId !== null}
                          aria-label={`${t("dashboard.delete")}: ${p.project_id}`}
                          onClick={() => setDeleteTarget(p)}
                        >
                          <Trash2 className={cn("size-4", deletingId === p.project_id && "opacity-40")} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>

          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {t("dashboard.pageInfo", { total: String(total) })}
              {total > 0 ? t("dashboard.pageNav", { cur: String(page + 1), all: String(totalPages) }) : null}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                {t("dashboard.perPage")}
                <select
                  className={cn(
                    "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                  value={pageSize}
                  onChange={(e) => onPageSizeChange(Number(e.target.value))}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                {t("dashboard.rows")}
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
                  {t("dashboard.prev")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page + 1 >= totalPages || total === 0}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("dashboard.next")}
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog
        open={reindexTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReindexTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dashboard.reindexDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {reindexTarget
                ? t("dashboard.reindexConfirm", {
                    id: (reindexTarget.project_name ?? "").trim() || reindexTarget.project_id,
                  })
                : "\u00a0"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reindexingId !== null}>{t("dashboard.reindexCancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={reindexingId !== null}
              onClick={() => {
                const target = reindexTarget;
                setReindexTarget(null);
                if (target) void performReindex(target);
              }}
            >
              {reindexingId !== null ? "…" : t("dashboard.reindex")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dashboard.deleteDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? t("dashboard.deleteConfirm", {
                    id: (deleteTarget.project_name ?? "").trim() || deleteTarget.project_id,
                  })
                : "\u00a0"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingId !== null}>{t("dashboard.deleteCancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingId !== null}
              className={cn(buttonVariants({ variant: "destructive" }))}
              onClick={() => {
                const target = deleteTarget;
                if (target) void performDelete(target);
              }}
            >
              {deletingId !== null ? "…" : t("dashboard.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
