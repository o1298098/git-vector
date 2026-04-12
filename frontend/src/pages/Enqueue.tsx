import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/i18n/I18nContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Enqueue() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [repoUrl, setRepoUrl] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
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
      let msg = text || `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { detail?: unknown };
        if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("enqueue.fail"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("enqueue.title")}</h1>
        <p className="text-muted-foreground">{t("enqueue.subtitle")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("enqueue.cardTitle")}</CardTitle>
          <CardDescription>{t("enqueue.cardDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="url">{t("enqueue.url")}</Label>
              <Input
                id="url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder={t("enqueue.urlPh")}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pid">{t("enqueue.pid")}</Label>
              <Input
                id="pid"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder={t("enqueue.pidPh")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pname">{t("enqueue.pname")}</Label>
              <Input
                id="pname"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={t("enqueue.pnamePh")}
              />
            </div>
            {err ? <p className="text-sm text-destructive">{err}</p> : null}
            <Button type="submit" disabled={loading || !repoUrl.trim()}>
              {loading ? t("enqueue.submitting") : t("enqueue.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
