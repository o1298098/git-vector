import { useCallback, useEffect, useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchResultContent } from "@/components/SearchResultContent";
import { SearchableProjectSelect } from "@/components/SearchableProjectSelect";
import { useI18n } from "@/i18n/I18nContext";

type Hit = {
  score?: number | null;
  distance?: number | null;
  content: string;
  metadata?: Record<string, unknown>;
};

/** 后端返回 score（越大越相关）；旧接口仅有 distance 时在前端换算 */
function formatRelevance(hit: Hit): string {
  if (typeof hit.score === "number" && Number.isFinite(hit.score)) {
    return hit.score.toFixed(4);
  }
  if (typeof hit.distance === "number" && Number.isFinite(hit.distance)) {
    return (1 / (1 + hit.distance)).toFixed(4);
  }
  return "—";
}

type ProjectOption = { project_id: string; project_name?: string | null };

function formatMetaLine(meta: Record<string, unknown>, linesLabel: string): string | null {
  const path = meta.path ?? meta.file;
  const name = meta.name;
  const sl = meta.start_line;
  const el = meta.end_line;
  const parts: string[] = [];
  if (path != null && String(path)) parts.push(String(path));
  if (name != null && String(name)) parts.push(String(name));
  if (sl != null || el != null) {
    parts.push(`${linesLabel} ${sl ?? "?"}-${el ?? sl ?? "?"}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

export function Search() {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [projectId, setProjectId] = useState("");
  const [topK, setTopK] = useState(10);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Hit[]>([]);
  const [err, setErr] = useState<string | null>(null);
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
    setErr(null);
    setLoading(true);
    setHasSearched(true);
    setResults([]);
    try {
      const params = new URLSearchParams({ q: q.trim(), top_k: String(topK) });
      if (projectId.trim()) params.set("project_id", projectId.trim());
      const data = await apiJson<{ results: Hit[] }>(`/api/search?${params.toString()}`);
      setResults(data.results ?? []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("search.searchFail"));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [q, projectId, topK, t]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim() || loading) return;
    void runSearch();
  }

  return (
    <div className="mx-auto max-w-[1600px]">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
        <aside
          className="w-full shrink-0 lg:sticky lg:top-20 lg:z-10 lg:w-80"
          aria-label={t("search.sidebarAria")}
        >
          <Card className="border shadow-sm">
            <CardHeader className="space-y-2 border-b bg-muted/30 py-4">
              <h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl">{t("search.title")}</h1>
              <p className="text-sm leading-snug text-muted-foreground">{t("search.subtitle")}</p>
            </CardHeader>
            <CardContent className="p-4 sm:p-5">
              <form onSubmit={onSubmit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="search-q" className="font-medium">
                    {t("search.queryLabel")}
                  </Label>
                  <Textarea
                    id="search-q"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t("search.queryPh")}
                    className="min-h-[120px] resize-y"
                    disabled={loading}
                  />
                </div>

                <div className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="search-project">{t("search.projectLabel")}</Label>
                    <SearchableProjectSelect
                      id="search-project"
                      value={projectId}
                      onChange={setProjectId}
                      projects={projects}
                      disabled={loading}
                      loading={projectsLoading}
                    />
                    <p className="text-xs text-muted-foreground">
                      {projectsLoading
                        ? t("projectSelect.hintLoading")
                        : projects.length === 0
                          ? t("projectSelect.hintEmpty")
                          : t("projectSelect.hintCount", { n: String(projects.length) })}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="search-topk">{t("search.topKLabel")}</Label>
                    <Input
                      id="search-topk"
                      type="number"
                      min={1}
                      max={50}
                      value={topK}
                      onChange={(e) => setTopK(Math.min(50, Math.max(1, Number(e.target.value) || 10)))}
                      disabled={loading}
                    />
                    <p className="text-xs text-muted-foreground">{t("search.topKHint")}</p>
                  </div>
                </div>

                {err ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    {err}
                  </div>
                ) : null}

                <div className="flex flex-col gap-2">
                  <Button type="submit" className="w-full gap-2" disabled={loading || !q.trim()}>
                    <SearchIcon className="size-4" />
                    {loading ? t("search.searching") : t("search.submit")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={loading}
                    onClick={() => {
                      setQ("");
                      setProjectId("");
                      setTopK(10);
                      setResults([]);
                      setErr(null);
                      setHasSearched(false);
                    }}
                  >
                    {t("search.clear")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </aside>

        <section className="min-w-0 flex-1 space-y-4" aria-live="polite" aria-label={t("search.resultsTitle")}>
          {!hasSearched && !loading ? (
            <Card className="border-dashed">
              <CardContent className="flex min-h-[min(50vh,24rem)] flex-col items-center justify-center px-6 py-12 text-center text-muted-foreground">
                <p className="max-w-md text-sm">{t("search.resultsPanelHint")}</p>
              </CardContent>
            </Card>
          ) : null}

          {loading && hasSearched ? (
            <Card className="border-dashed">
              <CardContent className="flex min-h-[min(40vh,16rem)] items-center justify-center text-muted-foreground">
                <p className="text-sm">{t("search.searching")}</p>
              </CardContent>
            </Card>
          ) : null}

          {hasSearched && !loading && results.length === 0 && !err ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                <p className="font-medium text-foreground">{t("search.noResultsTitle")}</p>
                <p className="mt-1 max-w-md text-sm">{t("search.noResultsDesc")}</p>
              </CardContent>
            </Card>
          ) : null}

          {!loading && results.length > 0 ? (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
                <h2 className="text-lg font-semibold">{t("search.resultsTitle")}</h2>
                <span className="text-sm text-muted-foreground">{t("search.resultsLine", { n: String(results.length) })}</span>
              </div>
              <ul className="space-y-4">
                {results.map((r, i) => {
                  const meta = r.metadata && typeof r.metadata === "object" ? r.metadata : {};
                  const metaLine = formatMetaLine(meta, t("search.lines"));
                  return (
                    <li key={i}>
                      <Card className="overflow-hidden transition-shadow hover:shadow-md">
                        <CardHeader className="space-y-2 border-b bg-muted/20 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium text-muted-foreground">
                              {t("search.hitRank", { i: String(i + 1) })}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {t("search.relevance")}{" "}
                              <span className="font-mono font-medium text-foreground">{formatRelevance(r)}</span>
                            </span>
                          </div>
                          {metaLine ? <p className="text-xs font-mono text-primary/90">{metaLine}</p> : null}
                        </CardHeader>
                        <CardContent className="space-y-3 pt-4 text-sm">
                          <SearchResultContent content={r.content} />
                          {Object.keys(meta).length > 0 && !metaLine ? (
                            <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-3 text-xs">
                              {JSON.stringify(meta, null, 2)}
                            </pre>
                          ) : null}
                        </CardContent>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
