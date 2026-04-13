import { useI18n } from "@/i18n/I18nContext";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SearchResultContent } from "@/components/SearchResultContent";
import { type Hit } from "../types";
import { formatMetaLine, formatRelevance } from "../utils";

type SearchResultsPanelProps = {
  loading: boolean;
  hasSearched: boolean;
  results: Hit[];
  error: string | null;
};

export function SearchResultsPanel({ loading, hasSearched, results, error }: SearchResultsPanelProps) {
  const { t } = useI18n();

  return (
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

      {hasSearched && !loading && results.length === 0 && !error ? (
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
            {results.map((result, index) => {
              const metadata = result.metadata && typeof result.metadata === "object" ? result.metadata : {};
              const metaLine = formatMetaLine(metadata, t("search.lines"));
              return (
                <li key={index}>
                  <Card className="overflow-hidden transition-shadow hover:shadow-md">
                    <CardHeader className="space-y-2 border-b bg-muted/20 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-muted-foreground">
                          {t("search.hitRank", { i: String(index + 1) })}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t("search.relevance")}{" "}
                          <span className="font-mono font-medium text-foreground">{formatRelevance(result)}</span>
                        </span>
                      </div>
                      {metaLine ? <p className="text-xs font-mono text-primary/90">{metaLine}</p> : null}
                    </CardHeader>
                    <CardContent className="space-y-3 pt-4 text-sm">
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
        </>
      ) : null}
    </section>
  );
}
