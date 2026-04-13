import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type EnqueueFormCardProps = {
  repoUrl: string;
  projectId: string;
  projectName: string;
  loading: boolean;
  error: string | null;
  onRepoUrlChange: (value: string) => void;
  onProjectIdChange: (value: string) => void;
  onProjectNameChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
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
  };
};

export function EnqueueFormCard({
  repoUrl,
  projectId,
  projectName,
  loading,
  error,
  onRepoUrlChange,
  onProjectIdChange,
  onProjectNameChange,
  onSubmit,
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
          <Button type="submit" disabled={loading || !repoUrl.trim()}>
            {loading ? text.submitting : text.submit}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
