import { useMemo } from "react";
import { Link } from "react-router-dom";
import { GitCommitHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";

export function ImpactAnalysis() {
  const { t } = useI18n();
  const workflow = useMemo(
    () => [
      t("impact.workflowHook"),
      t("impact.workflowApi"),
      t("impact.workflowJob"),
      t("impact.workflowResult"),
    ],
    [t],
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <GitCommitHorizontal className="size-6 text-primary" aria-hidden />
          <h1 className="text-2xl font-semibold tracking-tight">{t("impact.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("impact.subtitle")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("impact.setupTitle")}</CardTitle>
          <CardDescription>{t("impact.setupDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
            {workflow.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
          <pre className="overflow-auto rounded-md border bg-muted/20 p-3 font-mono text-xs text-muted-foreground">
{`#!/bin/sh
commit_sha=$(git rev-parse HEAD)
parent_sha=$(git rev-parse HEAD^ 2>NUL || echo "")
branch=$(git rev-parse --abbrev-ref HEAD)
curl -X POST http://127.0.0.1:8000/webhook/local-commit \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"my-repo\",\"repo_path\":\"$(pwd)\",\"commit_sha\":\"$commit_sha\",\"parent_commit_sha\":\"$parent_sha\",\"branch\":\"$branch\",\"trigger_source\":\"git_hook\"}"`}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/jobs">{t("impact.openJobs")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/usage">{t("impact.openUsage")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/audit">{t("impact.openAudit")}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
