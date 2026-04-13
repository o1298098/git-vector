import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/i18n/I18nContext";
import { apiJson } from "@/lib/api";
import { SearchResultsPanel } from "./components/SearchResultsPanel";
import { SearchSidebar } from "./components/SearchSidebar";
import { type Hit, type ProjectOption } from "./types";

export function Search() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [topK, setTopK] = useState(10);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Hit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiJson<{ projects: ProjectOption[] }>("/api/projects");
        if (!cancelled) setProjects(data.projects ?? []);
      } catch {
        if (!cancelled) setProjects([]);
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback(async () => {
    setError(null);
    setLoading(true);
    setHasSearched(true);
    setResults([]);
    try {
      const params = new URLSearchParams({ q: query.trim(), top_k: String(topK) });
      if (projectId.trim()) params.set("project_id", projectId.trim());
      const data = await apiJson<{ results: Hit[] }>(`/api/search?${params.toString()}`);
      setResults(data.results ?? []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("search.searchFail"));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, projectId, topK, t]);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim() || loading) return;
    void runSearch();
  }

  function resetForm() {
    setQuery("");
    setProjectId("");
    setTopK(10);
    setResults([]);
    setError(null);
    setHasSearched(false);
  }

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
        <SearchSidebar
          query={query}
          projectId={projectId}
          topK={topK}
          loading={loading}
          projects={projects}
          projectsLoading={projectsLoading}
          error={error}
          onQueryChange={setQuery}
          onProjectIdChange={setProjectId}
          onTopKChange={setTopK}
          onSubmit={onSubmit}
          onReset={resetForm}
        />
        <SearchResultsPanel loading={loading} hasSearched={hasSearched} results={results} error={error} />
      </div>
    </div>
  );
}
