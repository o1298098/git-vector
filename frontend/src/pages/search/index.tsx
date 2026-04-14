import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useI18n } from "@/i18n/I18nContext";
import { apiJson } from "@/lib/api";
import { SearchResultsPanel } from "./components/SearchResultsPanel";
import { SearchSidebar } from "./components/SearchSidebar";
import { type Hit, type ProjectOption } from "./types";

export function Search() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialState = useMemo(() => {
    const q = (searchParams.get("q") || "").trim();
    const pid = (searchParams.get("project_id") || "").trim();
    const rawTopK = Number(searchParams.get("top_k") || "10");
    const nextTopK = Number.isFinite(rawTopK) ? Math.max(1, Math.min(50, Math.round(rawTopK))) : 10;
    return { q, pid, topK: nextTopK };
  }, [searchParams]);

  const [query, setQuery] = useState(initialState.q);
  const [projectId, setProjectId] = useState(initialState.pid);
  const [topK, setTopK] = useState(initialState.topK);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Hit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(Boolean(initialState.q));
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const searchRequestSeqRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const projectsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (projectId.trim()) params.set("project_id", projectId.trim());
    params.set("top_k", String(topK));
    setSearchParams(params, { replace: true });
  }, [query, projectId, setSearchParams, topK]);

  useEffect(() => {
    projectsAbortRef.current?.abort();
    const controller = new AbortController();
    projectsAbortRef.current = controller;
    (async () => {
      try {
        const data = await apiJson<{ projects: ProjectOption[] }>("/api/projects", { signal: controller.signal });
        if (!controller.signal.aborted) setProjects(data.projects ?? []);
      } catch {
        if (!controller.signal.aborted) setProjects([]);
      } finally {
        if (!controller.signal.aborted) setProjectsLoading(false);
      }
    })();
    return () => {
      controller.abort();
    };
  }, []);

  const runSearch = useCallback(async () => {
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const requestSeq = searchRequestSeqRef.current + 1;
    searchRequestSeqRef.current = requestSeq;
    setError(null);
    setLoading(true);
    setHasSearched(true);
    try {
      const params = new URLSearchParams({ q: query.trim(), top_k: String(topK) });
      if (projectId.trim()) params.set("project_id", projectId.trim());
      const data = await apiJson<{ results: Hit[] }>(`/api/search?${params.toString()}`, { signal: controller.signal });
      if (controller.signal.aborted || requestSeq !== searchRequestSeqRef.current) return;
      setResults(data.results ?? []);
    } catch (err: unknown) {
      if (controller.signal.aborted || requestSeq !== searchRequestSeqRef.current) return;
      setError(err instanceof Error ? err.message : t("search.searchFail"));
      setResults([]);
    } finally {
      if (requestSeq !== searchRequestSeqRef.current) return;
      setLoading(false);
    }
  }, [query, projectId, topK, t]);

  useEffect(() => {
    if (!initialState.q) return;
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      projectsAbortRef.current?.abort();
    },
    [],
  );

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim() || loading) return;
    void runSearch();
  }

  function resetForm() {
    searchAbortRef.current?.abort();
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
