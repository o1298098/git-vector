import { useEffect, useState } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";
import { GitCommitHorizontal, MessageSquareMore, FolderKanban } from "lucide-react";
import { apiJson } from "@/lib/api";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { ProjectHeader } from "./components/ProjectHeader";
import type { ProjectSummary } from "./types";

export function ProjectDetailLayout() {
  const { t } = useI18n();
  const { projectId = "" } = useParams();
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const nav = [
    { to: "vectors", label: t("projectDetail.navVectors"), icon: FolderKanban },
    { to: "issue", label: t("projectDetail.navIssue"), icon: MessageSquareMore },
    { to: "impact", label: t("projectDetail.navImpact"), icon: GitCommitHorizontal },
  ];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!projectId) return;
      try {
        const data = await apiJson<ProjectSummary>(`/api/projects/${encodeURIComponent(projectId)}/summary`);
        if (!cancelled) setSummary(data);
      } catch {
        if (!cancelled) setSummary(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 px-1">
      <ProjectHeader summary={summary} projectId={projectId} onSummaryChange={setSummary} />

      <div className="overflow-x-auto">
        <nav className="inline-flex min-w-full gap-2 rounded-xl border bg-muted/30 p-2" aria-label={t("projectDetail.menuTitle")}>
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors",
                  "whitespace-nowrap",
                  isActive ? "bg-background text-primary shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-background/80 hover:text-foreground",
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </div>

      <section className="min-w-0">
        <Outlet />
      </section>
    </div>
  );
}
