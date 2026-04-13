import { useI18n } from "@/i18n/I18nContext";
import { Button } from "@/components/ui/button";

type JobsPageHeaderProps = {
  onRefresh: () => void;
};

export function JobsPageHeader({ onRefresh }: JobsPageHeaderProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("jobs.title")}</h1>
        <p className="text-muted-foreground">{t("jobs.subtitle")}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRefresh}>
        {t("jobs.refresh")}
      </Button>
    </div>
  );
}
