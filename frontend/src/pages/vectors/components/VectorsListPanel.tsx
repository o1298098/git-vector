import { ChevronLeft, ChevronRight } from "lucide-react";
import { SearchableProjectSelect } from "@/components/SearchableProjectSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/I18nContext";
import { oneLineSummary } from "../utils";
import { type ProjectOption, type VectorRow } from "../types";

type VectorsListPanelProps = {
  total: number;
  page: number;
  totalPages: number;
  projectId: string;
  projects: ProjectOption[];
  projectsLoading: boolean;
  searchInput: string;
  rows: VectorRow[];
  selectedId: string;
  loading: boolean;
  saving: boolean;
  onProjectChange: (projectId: string) => void;
  onSearchChange: (value: string) => void;
  onSelectRow: (id: string) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
};

export function VectorsListPanel({
  total,
  page,
  totalPages,
  projectId,
  projects,
  projectsLoading,
  searchInput,
  rows,
  selectedId,
  loading,
  saving,
  onProjectChange,
  onSearchChange,
  onSelectRow,
  onPrevPage,
  onNextPage,
}: VectorsListPanelProps) {
  const { t } = useI18n();

  return (
    <Card className="flex h-[min(84vh,860px)] flex-col xl:col-span-5">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">{t("vectors.title")}</CardTitle>
          <CardDescription className="text-xs">{t("vectors.listDesc", { total: String(total) })}</CardDescription>
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <SearchableProjectSelect
            id="vectors-project"
            value={projectId}
            onChange={onProjectChange}
            projects={projects}
            loading={projectsLoading}
            disabled={saving}
            compact
          />
          <Input
            id="vectors-search"
            value={searchInput}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("vectors.searchPlaceholder")}
            disabled={saving || !projectId}
          />
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background">
          {loading ? (
            <p className="p-4 text-sm text-muted-foreground">{t("vectors.loading")}</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("vectors.empty")}</p>
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-muted/60 ${selectedId === row.id ? "bg-muted" : ""}`}
                    onClick={() => onSelectRow(row.id)}
                  >
                    <div className="truncate font-medium">{oneLineSummary(row)}</div>
                    <div className="truncate text-xs text-muted-foreground">{row.id}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between">
          <span className="text-sm text-muted-foreground">{t("vectors.pageNav", { cur: String(page + 1), all: String(totalPages) })}</span>
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="sm" disabled={page <= 0 || loading} onClick={onPrevPage}>
              <ChevronLeft className="size-4" />
              {t("vectors.prev")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={page + 1 >= totalPages || loading} onClick={onNextPage}>
              {t("vectors.next")}
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
