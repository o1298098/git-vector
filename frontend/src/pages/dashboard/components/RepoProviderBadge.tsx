import { Building2, Github, GitBranch, Landmark } from "lucide-react";

type RepoProviderBadgeProps = {
  provider?: string | null;
};

function normalizeProvider(provider?: string | null): "gitlab" | "github" | "gitee" | "generic" {
  const value = String(provider || "").trim().toLowerCase();
  if (value === "gitlab") return "gitlab";
  if (value === "github") return "github";
  if (value === "gitee") return "gitee";
  return "generic";
}

export function RepoProviderBadge({ provider }: RepoProviderBadgeProps) {
  const value = normalizeProvider(provider);

  if (value === "gitlab") {
    return (
      <span
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300"
        title="GitLab"
        aria-label="GitLab"
      >
        <Building2 className="h-3.5 w-3.5 shrink-0" />
      </span>
    );
  }

  if (value === "github") {
    return (
      <span
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300"
        title="GitHub"
        aria-label="GitHub"
      >
        <Github className="h-3.5 w-3.5 shrink-0" />
      </span>
    );
  }

  if (value === "gitee") {
    return (
      <span
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        title="Gitee"
        aria-label="Gitee"
      >
        <Landmark className="h-3.5 w-3.5 shrink-0" />
      </span>
    );
  }

  return (
    <span
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-muted-foreground/20 bg-muted text-muted-foreground"
      title="Git"
      aria-label="Git"
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0" />
    </span>
  );
}
