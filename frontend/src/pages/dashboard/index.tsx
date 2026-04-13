import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/api";
import { useI18n } from "@/i18n/I18nContext";
import { DashboardDialogs } from "./components/DashboardDialogs";
import { DashboardProjectsCard } from "./components/DashboardProjectsCard";
import { DashboardQuickActions } from "./components/DashboardQuickActions";
import { PAGE_SIZES, SEARCH_DEBOUNCE_MS, type ProjectRow } from "./types";

export function Dashboard() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reindexingId, setReindexingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectRow | null>(null);
  const [reindexTarget, setReindexTarget] = useState<ProjectRow | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(0);
  }, [debouncedQ]);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(page * pageSize),
    });
    if (debouncedQ) params.set("q", debouncedQ);
    try {
      const data = await apiJson<{ total?: number; projects: ProjectRow[] }>(`/api/projects?${params}`);
      const totalCount = typeof data.total === "number" ? data.total : (data.projects?.length ?? 0);
      setTotal(totalCount);
      setProjects(data.projects ?? []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("search.loadFail"));
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

  function onPageSizeChange(size: number) {
    setPageSize(size);
    setPage(0);
  }

  async function performDelete(project: ProjectRow) {
    setDeletingId(project.project_id);
    setError(null);
    try {
      await apiJson<{ ok?: boolean }>(`/api/projects/${encodeURIComponent(project.project_id)}`, { method: "DELETE" });
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("dashboard.deleteFail"));
    } finally {
      setDeletingId(null);
    }
  }

  async function performReindex(project: ProjectRow) {
    setReindexingId(project.project_id);
    setError(null);
    try {
      await apiJson<{ status: string; job_id: string }>(`/api/projects/${encodeURIComponent(project.project_id)}/reindex`, {
        method: "POST",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("dashboard.reindexFail"));
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

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <DashboardQuickActions />
      <DashboardProjectsCard
        projects={projects}
        total={total}
        page={page}
        pageSize={pageSize}
        totalPages={totalPages}
        searchInput={searchInput}
        debouncedQ={debouncedQ}
        deletingId={deletingId}
        reindexingId={reindexingId}
        onSearchInputChange={setSearchInput}
        onPageSizeChange={onPageSizeChange}
        onPrevPage={() => setPage((currentPage) => Math.max(0, currentPage - 1))}
        onNextPage={() => setPage((currentPage) => currentPage + 1)}
        onReindexClick={setReindexTarget}
        onDeleteClick={setDeleteTarget}
      />
      <DashboardDialogs
        reindexTarget={reindexTarget}
        deleteTarget={deleteTarget}
        reindexingId={reindexingId}
        deletingId={deletingId}
        onCloseReindexDialog={() => setReindexTarget(null)}
        onCloseDeleteDialog={() => setDeleteTarget(null)}
        onConfirmReindex={(target) => {
          setReindexTarget(null);
          void performReindex(target);
        }}
        onConfirmDelete={(target) => {
          setDeleteTarget(null);
          void performDelete(target);
        }}
      />
    </div>
  );
}
