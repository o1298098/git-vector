import { Link } from "react-router-dom";
import { MessageSquareMore } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";

export function IssueReplySuggestions() {
  const { t } = useI18n();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <MessageSquareMore className="size-6 text-primary" aria-hidden />
          <h1 className="text-2xl font-semibold tracking-tight">{t("issueReply.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("issueReply.subtitle")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("issueReply.cardTitle")}</CardTitle>
          <CardDescription>{t("issueReply.cardDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <ul className="list-disc space-y-2 pl-5">
            <li>{t("issueReply.itemContext")}</li>
            <li>{t("issueReply.itemPolicy")}</li>
            <li>{t("issueReply.itemAudit")}</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/jobs">{t("issueReply.openJobs")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/audit">{t("issueReply.openAudit")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/usage">{t("issueReply.openUsage")}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
