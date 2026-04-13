import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Save } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableProjectSelect } from "@/components/SearchableProjectSelect";
import { useI18n } from "@/i18n/I18nContext";

type ProjectOption = { project_id: string; project_name?: string | null };
type VectorRow = { id: string; content: string; metadata: Record<string, unknown> };
type VectorListResp = { total: number; limit: number; offset: number; items: VectorRow[] };

const PAGE_SIZE = 20;

function prettyMeta(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta, null, 2);
  } catch {
    return "{}";
  }
}

function oneLineSummary(row: VectorRow): string {
  const m = row.metadata || {};
  const path = typeof m.path === "string" ? m.path : (typeof m.file === "string" ? m.file : "");
  const name = typeof m.name === "string" ? m.name : "";
  const sl = m.start_line;
  const el = m.end_line;
  const lines = sl != null || el != null ? `L${String(sl ?? "?")}-${String(el ?? sl ?? "?")}` : "";
  return [path, name, lines].filter(Boolean).join(" · ") || row.id;
}

export function Vectors() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProjectId = (searchParams.get("project_id") || "").trim();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [rows, setRows] = useState<VectorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState("");
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);
  const [editContent, setEditContent] = useState("");
  const [editMeta, setEditMeta] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiJson<{ projects: ProjectOption[] }>("/api/projects");
        if (cancelled) return;
        const list = data.projects ?? [];
        setProjects(list);
        if (!projectId && list.length > 0) setProjectId(list[0].project_id);
      } catch {
        if (!cancelled) setProjects([]);
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const qid = (searchParams.get("project_id") || "").trim();
    if (qid && qid !== projectId) setProjectId(qid);
  }, [searchParams, projectId]);

  useEffect(() => {
    const cur = (searchParams.get("project_id") || "").trim();
    const next = projectId.trim();
    if (cur === next) return;
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set("project_id", next);
    else sp.delete("project_id");
    setSearchParams(sp, { replace: true });
  }, [projectId, searchParams, setSearchParams]);

  const load = useCallback(async () => {
    if (!projectId) {
      setRows([]);
      setTotal(0);
      setSelectedId("");
      return;
    }
    setErr(null);
    setOk(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      const data = await apiJson<VectorListResp>(`/api/projects/${encodeURIComponent(projectId)}/vectors?${params}`);
      setRows(data.items ?? []);
      setTotal(typeof data.total === "number" ? data.total : 0);
      const firstId = data.items?.[0]?.id ?? "";
      setSelectedId((prev) => (prev && data.items.some((x) => x.id === prev) ? prev : firstId));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("vectors.loadFail"));
      setRows([]);
      setTotal(0);
      setSelectedId("");
    } finally {
      setLoading(false);
    }
  }, [page, projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(0);
  }, [projectId]);

  useEffect(() => {
    if (!selected) return;
    setEditContent(selected.content ?? "");
    setEditMeta(prettyMeta(selected.metadata ?? {}));
  }, [selected]);

  async function onSave() {
    if (!projectId || !selected) return;
    setErr(null);
    setOk(null);
    let metaObj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(editMeta);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(t("vectors.metaInvalid"));
      }
      metaObj = parsed as Record<string, unknown>;
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("vectors.metaInvalid"));
      return;
    }

    setSaving(true);
    try {
      await apiJson<{ ok: boolean }>(
        `/api/projects/${encodeURIComponent(projectId)}/vectors/${encodeURIComponent(selected.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ content: editContent, metadata: metaObj }),
        },
      );
      setOk(t("vectors.saved"));
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("vectors.saveFail"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("vectors.title")}</h1>
        <p className="text-muted-foreground">{t("vectors.subtitle")}</p>
      </div>

      <Card>
        <CardHeader className="space-y-2">
          <CardTitle>{t("vectors.projectScope")}</CardTitle>
          <CardDescription>{t("vectors.projectScopeDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="max-w-xl">
          <SearchableProjectSelect
            id="vectors-project"
            value={projectId}
            onChange={setProjectId}
            projects={projects}
            loading={projectsLoading}
            disabled={saving}
          />
        </CardContent>
      </Card>

      {err ? <p className="text-sm text-destructive">{err}</p> : null}
      {ok ? <p className="text-sm text-primary">{ok}</p> : null}

      <div className="grid gap-6 xl:grid-cols-12">
        <Card className="xl:col-span-5">
          <CardHeader>
            <CardTitle>{t("vectors.listTitle")}</CardTitle>
            <CardDescription>{t("vectors.listDesc", { total: String(total) })}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-h-[540px] overflow-auto rounded-md border">
              {loading ? (
                <p className="p-4 text-sm text-muted-foreground">{t("vectors.loading")}</p>
              ) : rows.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{t("vectors.empty")}</p>
              ) : (
                <ul className="divide-y">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className={`w-full px-3 py-2 text-left text-sm hover:bg-muted/60 ${selectedId === r.id ? "bg-muted" : ""}`}
                        onClick={() => setSelectedId(r.id)}
                      >
                        <div className="truncate font-medium">{oneLineSummary(r)}</div>
                        <div className="truncate text-xs text-muted-foreground">{r.id}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {t("vectors.pageNav", { cur: String(page + 1), all: String(totalPages) })}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 0 || loading}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="size-4" />
                  {t("vectors.prev")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page + 1 >= totalPages || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("vectors.next")}
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-7">
          <CardHeader>
            <CardTitle>{t("vectors.editorTitle")}</CardTitle>
            <CardDescription>
              {selected ? selected.id : t("vectors.editorEmpty")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="vector-content">{t("vectors.contentLabel")}</Label>
              <Textarea
                id="vector-content"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="min-h-[180px] font-mono text-xs"
                disabled={!selected || saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vector-meta">{t("vectors.metaLabel")}</Label>
              <Textarea
                id="vector-meta"
                value={editMeta}
                onChange={(e) => setEditMeta(e.target.value)}
                className="min-h-[220px] font-mono text-xs"
                disabled={!selected || saving}
              />
              <p className="text-xs text-muted-foreground">{t("vectors.metaHint")}</p>
            </div>
            <div className="flex justify-end">
              <Button type="button" disabled={!selected || saving} onClick={() => void onSave()}>
                <Save className="mr-1 size-4" />
                {saving ? t("vectors.saving") : t("vectors.save")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
