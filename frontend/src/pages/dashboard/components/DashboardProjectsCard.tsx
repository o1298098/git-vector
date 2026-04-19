import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, ExternalLink, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import { safeProjectId } from "@/lib/projectId";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { PAGE_SIZES, type ProjectRow } from "../types";
import { formatProjectCreatedAt } from "../utils";
import { RepoProviderBadge } from "./RepoProviderBadge";

type DashboardProjectsCardProps = {
  projects: ProjectRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  loading: boolean;
  initialFetchDone: boolean;
  searchInput: string;
  debouncedQ: string;
  deletingId: string | null;
  reindexingId: string | null;
  renamingId: string | null;
  renameTargetId: string | null;
  onSearchInputChange: (value: string) => void;
  onPageSizeChange: (value: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onReindexClick: (project: ProjectRow) => void;
  onDeleteClick: (project: ProjectRow) => void;
  onRenameClick: (project: ProjectRow) => void;
};

export function DashboardProjectsCard({
  projects,
  total,
  page,
  pageSize,
  totalPages,
  loading,
  initialFetchDone,
  searchInput,
  debouncedQ,
  deletingId,
  reindexingId,
  renamingId,
  renameTargetId,
  onSearchInputChange,
  onPageSizeChange,
  onPrevPage,
  onNextPage,
  onReindexClick,
  onDeleteClick,
  onRenameClick,
}: DashboardProjectsCardProps) {
  const { t } = useI18n();
  const showInitialSkeleton = loading && projects.length === 0 && !initialFetchDone;
  const showSoftRefresh = loading && projects.length > 0;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>{t("dashboard.projectsTitle")}</CardTitle>
          <CardDescription>{t("dashboard.projectsDesc")}</CardDescription>
        </div>
        <div className="relative w-full sm:w-[20rem]">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder={t("dashboard.searchPlaceholder")}
            className="pl-9"
            value={searchInput}
            onChange={(event) => onSearchInputChange(event.target.value)}
            aria-label="搜索项目"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <div
            className={cn(
              "w-full overflow-x-auto transition-opacity duration-300 ease-out",
              showSoftRefresh ? "opacity-[0.93]" : "opacity-100",
            )}
            aria-busy={showSoftRefresh}
          >
            <Table className="table-fixed min-w-[69rem]">
              <colgroup>
                <col className="w-60" />
                <col className="min-w-[11rem]" />
                <col className="w-44" />
                <col className="w-20" />
                <col className="w-36" />
                <col className="w-36" />
                <col className="w-40" />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap align-middle">{t("dashboard.colProjectId")}</TableHead>
                  <TableHead className="whitespace-nowrap align-middle">{t("dashboard.colProjectName")}</TableHead>
                  <TableHead className="whitespace-nowrap align-middle">{t("dashboard.colCreatedAt")}</TableHead>
                  <TableHead className="whitespace-nowrap text-right align-middle">{t("dashboard.colVectors")}</TableHead>
                  <TableHead className="align-middle">{t("dashboard.colRepo")}</TableHead>
                  <TableHead className="align-middle">{t("dashboard.colWiki")}</TableHead>
                  <TableHead className="whitespace-nowrap text-center align-middle">{t("dashboard.colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {showInitialSkeleton ? (
                  Array.from({ length: 6 }).map((_, index) => (
                    <TableRow key={`project-skeleton-${index}`}>
                      <TableCell>
                        <div className="h-4 w-[85%] animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell>
                        <div className="h-4 w-[70%] animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell>
                        <div className="h-4 w-[75%] animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell>
                        <div className="ml-auto h-4 w-12 animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell>
                        <div className="h-8 w-full animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell>
                        <div className="h-8 w-full animate-pulse rounded bg-muted" />
                      </TableCell>
                      <TableCell>
                        <div className="mx-auto h-8 w-16 animate-pulse rounded bg-muted" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : projects.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-muted-foreground">
                      {debouncedQ ? t("dashboard.emptyFiltered") : t("dashboard.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  projects.map((project) => {
                    const displayName = project.project_name?.trim() ? project.project_name : t("dashboard.dash");
                    return (
                      <TableRow key={project.project_id}>
                        <TableCell className="font-mono text-sm">
                          <div className="flex min-w-0 items-center gap-2">
                            <RepoProviderBadge provider={project.repo_provider} />
                            <Link
                              to={`/projects/${encodeURIComponent(project.project_id)}`}
                              className="block min-w-0 truncate text-primary hover:underline"
                              title={`${t("projectDetail.title")}: ${project.project_id}`}
                            >
                              {project.project_id}
                            </Link>
                          </div>
                        </TableCell>
                        <TableCell className="min-w-0 text-sm text-muted-foreground">
                          <Link
                            to={`/projects/${encodeURIComponent(project.project_id)}`}
                            className="block truncate hover:text-foreground hover:underline"
                            title={displayName === t("dashboard.dash") ? undefined : `${t("projectDetail.title")}: ${displayName}`}
                          >
                            {displayName}
                          </Link>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          {formatProjectCreatedAt(project.created_at) || t("dashboard.dash")}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{project.doc_count}</TableCell>
                        <TableCell>
                          {project.repo_url ? (
                            <Button variant="outline" size="sm" className="h-8 w-full max-w-full justify-center gap-1 px-2" asChild>
                              <a href={project.repo_url} target="_blank" rel="noreferrer">
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
                            <a href={`/wiki/${safeProjectId(project.project_id)}/site/`} target="_blank" rel="noreferrer">
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
                              className="size-9 text-muted-foreground hover:bg-muted hover:text-foreground"
                              disabled={
                                deletingId !== null ||
                                reindexingId !== null ||
                                renamingId !== null ||
                                renameTargetId !== null
                              }
                              aria-label={`${t("dashboard.rename")}: ${project.project_id}`}
                              onClick={() => onRenameClick(project)}
                            >
                              <Pencil
                                className={cn(
                                  "size-4",
                                  renamingId === project.project_id && "animate-pulse",
                                  renamingId !== null && renamingId !== project.project_id && "opacity-40",
                                )}
                              />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-9 text-primary hover:bg-primary/10 hover:text-primary"
                              disabled={
                                deletingId !== null ||
                                reindexingId !== null ||
                                renamingId !== null ||
                                renameTargetId !== null
                              }
                              aria-label={`${t("dashboard.reindex")}: ${project.project_id}`}
                              onClick={() => onReindexClick(project)}
                            >
                              <RefreshCw
                                className={cn(
                                  "size-4",
                                  reindexingId === project.project_id && "animate-spin",
                                  reindexingId !== null && reindexingId !== project.project_id && "opacity-40",
                                )}
                              />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              disabled={
                                deletingId !== null ||
                                reindexingId !== null ||
                                renamingId !== null ||
                                renameTargetId !== null
                              }
                              aria-label={`${t("dashboard.delete")}: ${project.project_id}`}
                              onClick={() => onDeleteClick(project)}
                            >
                              <Trash2 className={cn("size-4", deletingId === project.project_id && "opacity-40")} />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>

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
                onChange={(event) => onPageSizeChange(Number(event.target.value))}
                disabled={loading}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
              {t("dashboard.rows")}
            </label>
            <div className="flex items-center gap-1">
              <Button type="button" variant="outline" size="sm" disabled={page <= 0 || loading} onClick={onPrevPage}>
                <ChevronLeft className="size-4" />
                {t("dashboard.prev")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page + 1 >= totalPages || total === 0 || loading}
                onClick={onNextPage}
              >
                {t("dashboard.next")}
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
