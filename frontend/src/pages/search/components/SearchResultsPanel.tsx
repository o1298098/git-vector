import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useI18n } from "@/i18n/I18nContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SearchResultContent } from "@/components/SearchResultContent";
import { type Hit } from "../types";
import { formatMetaLine, formatRelevance, normalizeSourceUrl } from "../utils";

type SearchResultsPanelProps = {
  loading: boolean;
  hasSearched: boolean;
  results: Hit[];
  error: string | null;
};

function SearchResultsSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {Array.from({ length: 3 }).map((_, index) => (
        <Card key={index} className="min-w-0 overflow-hidden">
          <CardHeader className="min-w-0 border-b bg-muted/20 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                <div className="h-5 w-5 animate-pulse rounded bg-muted" />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 pt-4">
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-3 w-[92%] animate-pulse rounded bg-muted" />
            <div className="h-3 w-[88%] animate-pulse rounded bg-muted" />
            <div className="h-3 w-[70%] animate-pulse rounded bg-muted" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function SearchResultsPanel({ loading, hasSearched, results, error }: SearchResultsPanelProps) {
  const { t } = useI18n();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const showInitialSkeleton = loading && hasSearched && results.length === 0;
  const showRefreshingOverlay = loading && hasSearched && results.length > 0;

  async function copyCitation(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1200);
    } catch {
      setCopiedKey(null);
    }
  }

  return (
    <section className="min-w-0 flex-1 space-y-4" aria-live="polite" aria-label={t("search.resultsTitle")}>
      {!hasSearched && !loading ? (
        <Card className="border-dashed">
          <CardContent className="flex min-h-[min(50vh,24rem)] flex-col items-center justify-center px-6 py-12 text-center text-muted-foreground">
            <p className="max-w-md text-sm">{t("search.resultsPanelHint")}</p>
          </CardContent>
        </Card>
      ) : null}

      {showInitialSkeleton ? (
        <div role="status" aria-live="polite" aria-label={t("search.searching")}>
          <SearchResultsSkeleton />
        </div>
      ) : null}

      {hasSearched && !loading && results.length === 0 && !error ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <p className="font-medium text-foreground">{t("search.noResultsTitle")}</p>
            <p className="mt-1 max-w-md text-sm">{t("search.noResultsDesc")}</p>
          </CardContent>
        </Card>
      ) : null}

      {results.length > 0 ? (
        <div className="relative">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
            <h2 className="text-lg font-semibold">{t("search.resultsTitle")}</h2>
            <span className="text-sm text-muted-foreground">{t("search.resultsLine", { n: String(results.length) })}</span>
          </div>
          <ul className="space-y-4 pt-4">
            {results.map((result, index) => {
              const metadata = result.metadata && typeof result.metadata === "object" ? result.metadata : {};
              const metaLine = formatMetaLine(metadata, t("search.lines"));
              const sourceUrl = normalizeSourceUrl(result.source_url);
              const copyKey = `${index}-${result.citation ?? ""}`;
              return (
                <li key={index} className="min-w-0">
                  <Card className="min-w-0 overflow-hidden transition-shadow hover:shadow-md">
                    <CardHeader className="min-w-0 border-b bg-muted/20 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <span className="text-sm font-medium text-muted-foreground">
                            {t("search.hitRank", { i: String(index + 1) })}
                          </span>
                          {metaLine ? (
                            <p
                              className="truncate text-xs font-mono text-primary/90"
                              title={metaLine}
                            >
                              {metaLine}
                            </p>
                          ) : (
                            <p className="h-4 text-xs" aria-hidden />
                          )}
                        </div>
                        <div className="shrink-0 flex items-center gap-2">
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t("search.relevance")}{" "}
                            <span className="font-mono font-medium text-foreground">{formatRelevance(result)}</span>
                          </span>
                          {sourceUrl ? (
                            <Button
                              asChild
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-[22px] w-[22px] p-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                              title={t("search.openSource")}
                            >
                              <a href={sourceUrl} target="_blank" rel="noreferrer" aria-label={t("search.openSource")}>
                                <ExternalLink className="size-[14px]" />
                              </a>
                            </Button>
                          ) : null}
                          {result.citation ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-[22px] w-[22px] p-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                              onClick={() => void copyCitation(result.citation ?? "", copyKey)}
                              title={copiedKey === copyKey ? t("search.copyCitationDone") : t("search.copyCitation")}
                              aria-label={copiedKey === copyKey ? t("search.copyCitationDone") : t("search.copyCitation")}
                            >
                              {copiedKey === copyKey ? <Check className="size-[14px]" /> : <Copy className="size-[14px]" />}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="min-w-0 space-y-3 pt-4 text-sm">
                      <SearchResultContent content={result.content} />
                      {Object.keys(metadata).length > 0 && !metaLine ? (
                        <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-3 text-xs">
                          {JSON.stringify(metadata, null, 2)}
                        </pre>
                      ) : null}
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
          {showRefreshingOverlay ? (
            <div
              role="status"
              aria-live="polite"
              aria-label={t("search.searching")}
              className="pointer-events-none absolute inset-0 rounded-md bg-background/45 backdrop-blur-[1px]"
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
