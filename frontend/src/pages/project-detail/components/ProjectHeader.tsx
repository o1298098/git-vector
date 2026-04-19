import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Pencil, Save, X } from "lucide-react";
import { apiJson } from "@/lib/api";
import { useI18n } from "@/i18n/I18nContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProjectSummary } from "../types";

type ProjectHeaderProps = {
  summary: ProjectSummary | null;
  projectId: string;
  onSummaryChange?: (summary: ProjectSummary) => void;
};

type RepoProviderOption = "__auto__" | "github" | "gitlab" | "gitee" | "bitbucket";

type RepoConfigResponse = {
  project_id: string;
  repo_provider_override: string;
  repo_web_base_url: string;
};

function shortText(value: string | number | null | undefined, max = 8): string {
  const text = String(value || "").trim();
  if (!text) return "—";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function InfoTag({
  label,
  value,
  title,
}: {
  label: string;
  value: string | number | null | undefined;
  title?: string;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground"
      title={title || String(value || "")}
    >
      <span className="shrink-0">{label}</span>
      <span className="max-w-[120px] truncate font-medium text-foreground">{value || "—"}</span>
    </span>
  );
}

export function ProjectHeader({ summary, projectId, onSummaryChange }: ProjectHeaderProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");
  const [provider, setProvider] = useState<RepoProviderOption>("__auto__");
  const [repoWebBaseUrl, setRepoWebBaseUrl] = useState("");

  useEffect(() => {
    setProvider(((summary?.repo_provider_override || "__auto__") as RepoProviderOption) || "__auto__");
    setRepoWebBaseUrl(summary?.repo_web_base_url || "");
  }, [summary?.repo_provider_override, summary?.repo_web_base_url]);

  const effectiveRepoUrl = useMemo(() => summary?.repo_url || repoWebBaseUrl || "", [repoWebBaseUrl, summary?.repo_url]);

  async function handleSave() {
    if (!projectId) return;
    setSaving(true);
    setError("");
    try {
      const saved = await apiJson<RepoConfigResponse>(`/api/projects/${encodeURIComponent(projectId)}/repo-config`, {
        method: "PUT",
        body: JSON.stringify({
          repo_provider_override: provider === "__auto__" ? "" : provider,
          repo_web_base_url: repoWebBaseUrl.trim(),
        }),
      });
      if (summary && onSummaryChange) {
        onSummaryChange({
          ...summary,
          repo_provider: saved.repo_provider_override || summary.repo_provider,
          repo_provider_override: saved.repo_provider_override || null,
          repo_web_base_url: saved.repo_web_base_url || null,
          repo_url: saved.repo_web_base_url || summary.repo_url || null,
        });
      }
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projectDetail.repoConfigSaveFail"));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setProvider(((summary?.repo_provider_override || "__auto__") as RepoProviderOption) || "__auto__");
    setRepoWebBaseUrl(summary?.repo_web_base_url || "");
    setError("");
    setEditing(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-xl border bg-background px-4 py-4 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
              {summary?.project_name || t("projectDetail.title")}
            </h1>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{projectId}</span>
            <InfoTag label={t("projectDetail.metaVectors")} value={summary?.doc_count} />
            <InfoTag label={t("projectDetail.metaProvider")} value={summary?.repo_provider} />
            <InfoTag
              label={t("projectDetail.metaLastIndexed")}
              value={shortText(summary?.last_indexed_commit)}
              title={summary?.last_indexed_commit || undefined}
            />
            <InfoTag
              label={t("projectDetail.metaLastImpact")}
              value={shortText(summary?.last_analyzed_commit)}
              title={summary?.last_analyzed_commit || undefined}
            />
            <InfoTag label={t("projectDetail.metaIssueJobs")} value={summary?.issue_job_count} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 self-start">
          {effectiveRepoUrl ? (
            <a
              href={effectiveRepoUrl}
              target="_blank"
              rel="noreferrer"
              title={t("projectDetail.openRepo")}
              aria-label={t("projectDetail.openRepo")}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="size-4" aria-hidden />
            </a>
          ) : null}
          {!editing ? (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setEditing(true)}
              title={t("projectDetail.repoConfigEdit")}
              aria-label={t("projectDetail.repoConfigEdit")}
            >
              <Pencil className="size-4" />
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving}>
                <X className="mr-1 size-4" />
                {t("projectDetail.repoConfigCancel")}
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                <Save className="mr-1 size-4" />
                {saving ? t("projectDetail.repoConfigSaving") : t("projectDetail.repoConfigSave")}
              </Button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <div className="grid gap-3 rounded-xl border bg-muted/20 p-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2">
            <Label htmlFor="repo-provider-override">{t("projectDetail.repoProviderOverride")}</Label>
            <Select value={provider} onValueChange={(value) => setProvider(value as RepoProviderOption)}>
              <SelectTrigger id="repo-provider-override">
                <SelectValue placeholder={t("projectDetail.repoProviderAuto")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__">{t("projectDetail.repoProviderAuto")}</SelectItem>
                <SelectItem value="github">GitHub</SelectItem>
                <SelectItem value="gitlab">GitLab</SelectItem>
                <SelectItem value="gitee">Gitee</SelectItem>
                <SelectItem value="bitbucket">Bitbucket</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="repo-web-base-url">{t("projectDetail.repoWebBaseUrl")}</Label>
            <Input
              id="repo-web-base-url"
              value={repoWebBaseUrl}
              onChange={(event) => setRepoWebBaseUrl(event.target.value)}
              placeholder={t("projectDetail.repoWebBaseUrlPlaceholder")}
            />
          </div>
          {error ? <p className="text-sm text-destructive md:col-span-2">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
