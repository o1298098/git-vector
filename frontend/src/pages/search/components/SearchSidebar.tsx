import { Search as SearchIcon } from "lucide-react";
import { useI18n } from "@/i18n/I18nContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableProjectSelect } from "@/components/SearchableProjectSelect";
import { type ProjectOption } from "../types";

type SearchSidebarProps = {
  query: string;
  projectId: string;
  topK: number;
  loading: boolean;
  projects: ProjectOption[];
  projectsLoading: boolean;
  error: string | null;
  onQueryChange: (value: string) => void;
  onProjectIdChange: (value: string) => void;
  onTopKChange: (value: number) => void;
  onSubmit: (event: React.FormEvent) => void;
  onReset: () => void;
};

export function SearchSidebar({
  query,
  projectId,
  topK,
  loading,
  projects,
  projectsLoading,
  error,
  onQueryChange,
  onProjectIdChange,
  onTopKChange,
  onSubmit,
  onReset,
}: SearchSidebarProps) {
  const { t } = useI18n();

  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-20 lg:z-10 lg:w-80" aria-label={t("search.sidebarAria")}>
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
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
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
                  onChange={onProjectIdChange}
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
                  onChange={(event) => onTopKChange(Math.min(50, Math.max(1, Number(event.target.value) || 10)))}
                  disabled={loading}
                />
                <p className="text-xs text-muted-foreground">{t("search.topKHint")}</p>
              </div>
            </div>

            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <Button type="submit" className="w-full gap-2" disabled={loading || !query.trim()}>
                <SearchIcon className="size-4" />
                {loading ? t("search.searching") : t("search.submit")}
              </Button>
              <Button type="button" variant="outline" className="w-full" disabled={loading} onClick={onReset}>
                {t("search.clear")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </aside>
  );
}
