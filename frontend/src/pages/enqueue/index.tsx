import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "@/i18n/I18nContext";
import { apiFetch } from "@/lib/api";
import { EnqueueFormCard } from "./components/EnqueueFormCard";
import { EnqueuePageHeader } from "./components/EnqueuePageHeader";

function detectRepoProvider(repoUrl: string): "gitlab" | "github" | "gitee" | "generic" {
  const raw = repoUrl.trim().toLowerCase();
  if (!raw) return "generic";
  if (raw.startsWith("git@")) {
    const host = raw.split(":", 1)[0]?.split("@", 2)[1] ?? "";
    if (host.includes("github")) return "github";
    if (host.includes("gitee")) return "gitee";
    if (host.includes("gitlab")) return "gitlab";
    return "generic";
  }
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host.includes("github")) return "github";
    if (host.includes("gitee")) return "gitee";
    if (host.includes("gitlab")) return "gitlab";
  } catch {
    return "generic";
  }
  return "generic";
}

export function Enqueue() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [repoUrl, setRepoUrl] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [precheckLoading, setPrecheckLoading] = useState(false);
  const [precheckResult, setPrecheckResult] = useState<{
    ok: boolean;
    repo_provider?: string;
    checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
  } | null>(null);
  const repoProvider = useMemo(() => detectRepoProvider(repoUrl), [repoUrl]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const body: Record<string, string> = { repo_url: repoUrl.trim() };
      if (projectId.trim()) body.project_id = projectId.trim();
      if (projectName.trim()) body.project_name = projectName.trim();
      const res = await apiFetch("/api/index-jobs/enqueue", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) {
        navigate("/jobs");
        return;
      }
      let message = text || `HTTP ${res.status}`;
      try {
        const json = JSON.parse(text) as { detail?: unknown };
        if (json?.detail) message = typeof json.detail === "string" ? json.detail : JSON.stringify(json.detail);
      } catch {
        /* ignore parse errors */
      }
      throw new Error(message);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("enqueue.fail"));
    } finally {
      setLoading(false);
    }
  }

  async function precheck() {
    setError(null);
    setPrecheckLoading(true);
    try {
      const res = await apiFetch("/api/index-jobs/precheck", {
        method: "POST",
        body: JSON.stringify({
          repo_url: repoUrl.trim(),
          project_id: projectId.trim() || undefined,
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        let message = text || `HTTP ${res.status}`;
        try {
          const json = JSON.parse(text) as { detail?: unknown };
          if (json?.detail) message = typeof json.detail === "string" ? json.detail : JSON.stringify(json.detail);
        } catch {
          /* ignore parse errors */
        }
        throw new Error(message);
      }
      const data = JSON.parse(text) as {
        ok: boolean;
        repo_provider?: string;
        checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
      };
      setPrecheckResult(data);
      if (!data.ok) setError(t("enqueue.precheckFail"));
    } catch (err: unknown) {
      setPrecheckResult(null);
      setError(err instanceof Error ? err.message : t("enqueue.precheckFail"));
    } finally {
      setPrecheckLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <EnqueuePageHeader title={t("enqueue.title")} subtitle={t("enqueue.subtitle")} />
      <div className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
        <span className="font-medium text-foreground">仓库类型识别：</span>{" "}
        {repoProvider === "generic"
          ? "未识别，将使用通用逻辑"
          : repoProvider === "gitlab"
            ? "GitLab"
            : repoProvider === "github"
              ? "GitHub"
              : "Gitee"}
      </div>
      <EnqueueFormCard
        repoUrl={repoUrl}
        projectId={projectId}
        projectName={projectName}
        loading={loading}
        precheckLoading={precheckLoading}
        precheckResult={precheckResult}
        error={error}
        onRepoUrlChange={setRepoUrl}
        onProjectIdChange={setProjectId}
        onProjectNameChange={setProjectName}
        onSubmit={submit}
        onPrecheck={() => void precheck()}
        text={{
          cardTitle: t("enqueue.cardTitle"),
          cardDesc: t("enqueue.cardDesc"),
          urlLabel: t("enqueue.url"),
          urlPlaceholder: t("enqueue.urlPh"),
          projectIdLabel: t("enqueue.pid"),
          projectIdPlaceholder: t("enqueue.pidPh"),
          projectNameLabel: t("enqueue.pname"),
          projectNamePlaceholder: t("enqueue.pnamePh"),
          submit: t("enqueue.submit"),
          submitting: t("enqueue.submitting"),
          precheck: t("enqueue.precheck"),
          prechecking: t("enqueue.prechecking"),
          precheckOk: t("enqueue.precheckOk"),
          precheckFail: t("enqueue.precheckFail"),
        }}
      />
    </div>
  );
}
