import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type EnqueueFormCardProps = {
  repoUrl: string;
  projectId: string;
  projectName: string;
  loading: boolean;
  precheckLoading: boolean;
  precheckResult: { ok: boolean; checks: Array<{ key: string; label: string; ok: boolean; detail: string }> } | null;
  error: string | null;
  onRepoUrlChange: (value: string) => void;
  onProjectIdChange: (value: string) => void;
  onProjectNameChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onPrecheck: () => void;
  text: {
    cardTitle: string;
    cardDesc: string;
    urlLabel: string;
    urlPlaceholder: string;
    projectIdLabel: string;
    projectIdPlaceholder: string;
    projectNameLabel: string;
    projectNamePlaceholder: string;
    submit: string;
    submitting: string;
    precheck: string;
    prechecking: string;
    precheckOk: string;
    precheckFail: string;
  };
};

export function EnqueueFormCard({
  repoUrl,
  projectId,
  projectName,
  loading,
  precheckLoading,
  precheckResult,
  error,
  onRepoUrlChange,
  onProjectIdChange,
  onProjectNameChange,
  onSubmit,
  onPrecheck,
  text,
}: EnqueueFormCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{text.cardTitle}</CardTitle>
        <CardDescription>{text.cardDesc}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="url">{text.urlLabel}</Label>
            <Input
              id="url"
              value={repoUrl}
              onChange={(event) => onRepoUrlChange(event.target.value)}
              placeholder={text.urlPlaceholder}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pid">{text.projectIdLabel}</Label>
            <Input
              id="pid"
              value={projectId}
              onChange={(event) => onProjectIdChange(event.target.value)}
              placeholder={text.projectIdPlaceholder}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pname">{text.projectNameLabel}</Label>
            <Input
              id="pname"
              value={projectName}
              onChange={(event) => onProjectNameChange(event.target.value)}
              placeholder={text.projectNamePlaceholder}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {precheckResult ? (
            <div
              className={`rounded-md border px-3 py-2 text-xs ${
                precheckResult.ok ? "border-emerald-500/40 bg-emerald-500/10" : "border-destructive/30 bg-destructive/5"
              }`}
            >
              <p className="mb-1 font-medium">{precheckResult.ok ? text.precheckOk : text.precheckFail}</p>
              <ul className="space-y-1">
                {precheckResult.checks.map((item) => (
                  <li key={item.key} className={item.ok ? "text-foreground" : "text-destructive"}>
                    {item.ok ? "✓" : "✕"} {item.label}: {item.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={precheckLoading || !repoUrl.trim()} onClick={onPrecheck}>
              {precheckLoading ? text.prechecking : text.precheck}
            </Button>
            <Button type="submit" disabled={loading || !repoUrl.trim()}>
              {loading ? text.submitting : text.submit}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
