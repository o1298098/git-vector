import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, ExternalLink, MessageCircle, Search } from "lucide-react";
import { apiJson } from "@/lib/api";
import { safeProjectId } from "@/lib/projectId";
import { Button } from "@/components/ui/button";
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

type ProjectRow = { project_id: string; doc_count: number; project_name?: string | null; repo_url?: string | null };

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

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("dashboard.colProjectId")}</TableHead>
                <TableHead>{t("dashboard.colProjectName")}</TableHead>
                <TableHead className="text-right">{t("dashboard.colVectors")}</TableHead>
                <TableHead className="w-[120px]">{t("dashboard.colRepo")}</TableHead>
                <TableHead className="w-[200px]">{t("dashboard.colWiki")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    {debouncedQ ? t("dashboard.emptyFiltered") : t("dashboard.empty")}
                  </TableCell>
                </TableRow>
              ) : (
                projects.map((p) => (
                  <TableRow key={p.project_id}>
                    <TableCell className="font-mono text-sm">{p.project_id}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.project_name?.trim() ? p.project_name : t("dashboard.dash")}
                    </TableCell>
                    <TableCell className="text-right">{p.doc_count}</TableCell>
                    <TableCell>
                      {p.repo_url ? (
                        <Button variant="outline" size="sm" asChild>
                          <a href={p.repo_url} target="_blank" rel="noreferrer">
                            {t("dashboard.openRepo")}
                            <ExternalLink className="size-3" />
                          </a>
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t("dashboard.dash")}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" asChild>
                        <a href={`/wiki/${safeProjectId(p.project_id)}/site/`} target="_blank" rel="noreferrer">
                          {t("dashboard.openWiki")}
                          <ExternalLink className="size-3" />
                        </a>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
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
    </div>
  );
}
