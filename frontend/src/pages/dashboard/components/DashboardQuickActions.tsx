import { Link } from "react-router-dom";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { DASHBOARD_ACTION_CLASS } from "../types";

export function DashboardQuickActions() {
  const { t } = useI18n();

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Card className="flex h-full flex-col">
        <CardHeader>
          <CardTitle>{t("dashboard.semanticTitle")}</CardTitle>
          <CardDescription>{t("dashboard.semanticDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="mt-auto">
          <Button
            asChild
            variant="outline"
            className={cn(DASHBOARD_ACTION_CLASS, "border-primary/45 text-primary hover:bg-primary/10 hover:text-primary")}
          >
            <Link to="/search">{t("dashboard.openSearch")}</Link>
          </Button>
        </CardContent>
      </Card>
      <Card className="flex h-full flex-col">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="size-4 shrink-0" aria-hidden />
            {t("dashboard.chatTitle")}
          </CardTitle>
          <CardDescription>{t("dashboard.chatDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="mt-auto">
          <Button
            asChild
            variant="outline"
            className={cn(
              DASHBOARD_ACTION_CLASS,
              "border-sky-500/45 text-sky-700 hover:bg-sky-500/10 hover:text-sky-800 dark:border-sky-400/40 dark:text-sky-300 dark:hover:bg-sky-950/60 dark:hover:text-sky-200",
            )}
          >
            <Link to="/chat">{t("dashboard.openChat")}</Link>
          </Button>
        </CardContent>
      </Card>
      <Card className="flex h-full flex-col">
        <CardHeader>
          <CardTitle>{t("dashboard.jobsTitle")}</CardTitle>
          <CardDescription>{t("dashboard.jobsDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="mt-auto">
          <Button
            asChild
            variant="outline"
            className={cn(DASHBOARD_ACTION_CLASS, "border-border text-foreground hover:bg-muted hover:text-foreground")}
          >
            <Link to="/jobs">{t("dashboard.openJobs")}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
