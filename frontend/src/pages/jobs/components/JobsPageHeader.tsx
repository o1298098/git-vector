import { Link } from "react-router-dom";
import { Plus, RefreshCw } from "lucide-react";
import { useI18n } from "@/i18n/I18nContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type JobsPageHeaderProps = {
  onRefresh: () => void;
  autoRefresh: boolean;
  onAutoRefreshChange: (next: boolean) => void;
  refreshing: boolean;
};

export function JobsPageHeader({ onRefresh, autoRefresh, onAutoRefreshChange, refreshing }: JobsPageHeaderProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("jobs.title")}</h1>
        <p className="text-muted-foreground">{t("jobs.subtitle")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          asChild
          aria-label={t("jobs.newIndex")}
          title={t("jobs.newIndex")}
        >
          <Link to="/enqueue">
            <Plus className="size-4" aria-hidden />
          </Link>
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={onRefresh}
          aria-label={t("jobs.refresh")}
          title={t("jobs.refresh")}
          disabled={refreshing}
        >
          <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-9 px-3"
          onClick={() => onAutoRefreshChange(!autoRefresh)}
        >
          {autoRefresh ? t("jobs.autoRefreshOn") : t("jobs.autoRefreshOff")}
        </Button>
      </div>
    </div>
  );
}
