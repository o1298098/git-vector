import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Save } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import Editor from "@monaco-editor/react";
import XMarkdown from "@ant-design/x-markdown";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableProjectSelect } from "@/components/SearchableProjectSelect";
import { useI18n } from "@/i18n/I18nContext";
import { useTheme } from "@/theme/ThemeContext";
import { MarkdownPre } from "@/pages/code-chat/components/MarkdownPre";

type ProjectOption = { project_id: string; project_name?: string | null };
type VectorRow = { id: string; content: string; metadata: Record<string, unknown> };
type VectorListResp = { total: number; limit: number; offset: number; items: VectorRow[] };

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

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

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, normalizeJson(v)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function Vectors() {
  const { t } = useI18n();
  const { resolvedDark } = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProjectId = (searchParams.get("project_id") || "").trim();
  const initialQ = (searchParams.get("q") || "").trim();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [rows, setRows] = useState<VectorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(initialQ);
  const [debouncedQ, setDebouncedQ] = useState(initialQ);

  const [selectedId, setSelectedId] = useState("");
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);
  const [editContent, setEditContent] = useState("");
  const [editMeta, setEditMeta] = useState("{}");
  const [contentMode, setContentMode] = useState<"edit" | "preview">("edit");
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
        if (!projectId && list.length > 0) {
          const first = list[0].project_id;
          setProjectId(first);
          setSearchParams({ project_id: first }, { replace: true });
        }
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
    if (qid && qid !== projectId) {
      setProjectId(qid);
      setPage(0);
    }
  }, [searchParams, projectId]);

  useEffect(() => {
    const q = (searchParams.get("q") || "").trim();
    if (q !== searchInput) {
      setSearchInput(q);
      setDebouncedQ(q);
      setPage(0);
    }
  }, [searchParams, searchInput]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

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
      if (debouncedQ) params.set("q", debouncedQ);
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
  }, [page, projectId, debouncedQ, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(0);
  }, [debouncedQ]);

  useEffect(() => {
    if (!selected) return;
    setEditContent(selected.content ?? "");
    setEditMeta(prettyMeta(selected.metadata ?? {}));
  }, [selected]);

  const selectedMeta = selected?.metadata ?? {};
  const selectedMetaPretty = useMemo(() => prettyMeta(selectedMeta), [selectedMeta]);
  const metaValidation = useMemo(() => {
    try {
      const parsed = JSON.parse(editMeta);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { parsed: null, valid: false };
      return { parsed: parsed as Record<string, unknown>, valid: true };
    } catch {
      return { parsed: null, valid: false };
    }
  }, [editMeta]);
  const hasChanges = useMemo(() => {
    if (!selected) return false;
    const contentChanged = editContent !== (selected.content ?? "");
    const metaChanged = metaValidation.valid
      ? stableJson(metaValidation.parsed) !== stableJson(selectedMeta)
      : editMeta !== selectedMetaPretty;
    return contentChanged || metaChanged;
  }, [selected, editContent, metaValidation, selectedMeta, editMeta, selectedMetaPretty]);
  const saveDisabled = !selected || saving || !hasChanges || !metaValidation.valid;
  const editorTheme = resolvedDark ? "vs-dark" : "vs";
  const contentEditorOptions = useMemo(
    () => ({
      minimap: { enabled: true },
      fontSize: 13,
      lineNumbers: "on" as const,
      smoothScrolling: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
      wordWrap: "on" as const,
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      renderWhitespace: "selection" as const,
      renderValidationDecorations: "off" as const,
    }),
    [],
  );
  const metaEditorOptions = useMemo(
    () => ({
      ...contentEditorOptions,
      minimap: { enabled: false },
      formatOnPaste: true,
      formatOnType: true,
      renderValidationDecorations: "off" as const,
    }),
    [contentEditorOptions],
  );

  const resetEditor = useCallback(() => {
    if (!selected) return;
    setEditContent(selected.content ?? "");
    setEditMeta(selectedMetaPretty);
    setErr(null);
  }, [selected, selectedMetaPretty]);

  const formatMeta = useCallback(() => {
    if (!metaValidation.valid || !metaValidation.parsed) return;
    setEditMeta(prettyMeta(metaValidation.parsed));
  }, [metaValidation]);

  useEffect(() => {
    function onKeydown(ev: KeyboardEvent) {
      if (!(ev.metaKey || ev.ctrlKey) || ev.key.toLowerCase() !== "s") return;
      if (saveDisabled) return;
      ev.preventDefault();
      void onSave();
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [saveDisabled, projectId, selected, editContent, editMeta]);

  async function onSave() {
    if (!projectId || !selected) return;
    setErr(null);
    setOk(null);
    if (!hasChanges) {
      setOk(t("vectors.noChange"));
      return;
    }
    if (!metaValidation.valid || !metaValidation.parsed) {
      setErr(t("vectors.metaInvalid"));
      return;
    }
    const metaObj = metaValidation.parsed;

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
    <div className="mx-auto max-w-[1600px] space-y-4">
      {err ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {err}
        </div>
      ) : null}
      {ok ? (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">{ok}</div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="flex h-[min(84vh,860px)] flex-col xl:col-span-5">
          <CardHeader className="space-y-2 pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">{t("vectors.title")}</CardTitle>
              <CardDescription className="text-xs">{t("vectors.listDesc", { total: String(total) })}</CardDescription>
            </div>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <SearchableProjectSelect
                id="vectors-project"
                value={projectId}
                onChange={(pid) => {
                  const next = (pid || "").trim();
                  setProjectId(next);
                  setPage(0);
                  setSearchParams((prev) => {
                    const sp = new URLSearchParams(prev);
                    if (next) sp.set("project_id", next);
                    else sp.delete("project_id");
                    return sp;
                  }, { replace: true });
                }}
                projects={projects}
                loading={projectsLoading}
                disabled={saving}
                compact
              />
              <Input
                id="vectors-search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t("vectors.searchPlaceholder")}
                disabled={saving || !projectId}
              />
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background">
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
            <div className="flex shrink-0 items-center justify-between">
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

        <Card className="flex h-[min(84vh,860px)] flex-col xl:col-span-7">
          <CardHeader className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-lg">{t("vectors.editorTitle")}</CardTitle>
              {hasChanges ? (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                  {t("vectors.unsaved")}
                </span>
              ) : null}
            </div>
            <CardDescription className="font-mono text-xs">
              {selected ? selected.id : t("vectors.editorEmpty")}
            </CardDescription>
            <CardDescription className="text-xs text-muted-foreground">{t("vectors.saveShortcut")}</CardDescription>
          </CardHeader>
          <CardContent className="grid min-h-0 flex-1 grid-rows-[1fr_1fr_auto] gap-4">
            <div className="flex min-h-0 flex-col space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="vector-content">{t("vectors.contentLabel")}</Label>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={contentMode === "edit" ? "secondary" : "ghost"}
                    disabled={!selected}
                    onClick={() => setContentMode("edit")}
                  >
                    {t("vectors.contentModeEdit")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={contentMode === "preview" ? "secondary" : "ghost"}
                    disabled={!selected}
                    onClick={() => setContentMode("preview")}
                  >
                    {t("vectors.contentModePreview")}
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
                {contentMode === "edit" ? (
                  <Editor
                    height="100%"
                    language="markdown"
                    theme={editorTheme}
                    value={editContent}
                    onChange={(v: string | undefined) => setEditContent(v ?? "")}
                    options={{
                      ...contentEditorOptions,
                      minimap: { enabled: false },
                      readOnly: !selected || saving,
                    }}
                  />
                ) : (
                  <div className="h-full overflow-auto p-3">
                    {selected ? (
                      <div className={`gv-code-chat-bubbles ${resolvedDark ? "x-markdown-dark" : "x-markdown-light"}`}>
                        <XMarkdown content={editContent} components={{ pre: MarkdownPre }} />
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">{t("vectors.previewEmpty")}</p>
                    )}
                  </div>
                )}
              </div>
              {contentMode === "preview" ? (
                <p className="text-xs text-muted-foreground">{t("vectors.previewHint")}</p>
              ) : null}
            </div>
            <div className="flex min-h-0 flex-col space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="vector-meta">{t("vectors.metaLabel")}</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!selected || saving || !metaValidation.valid}
                  onClick={formatMeta}
                >
                  {t("vectors.formatMeta")}
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
                <Editor
                  height="100%"
                  language="json"
                  theme={editorTheme}
                  value={editMeta}
                  onChange={(v: string | undefined) => setEditMeta(v ?? "")}
                  options={{ ...metaEditorOptions, readOnly: !selected || saving }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{t("vectors.metaHint")}</p>
              {!metaValidation.valid ? (
                <p className="text-xs text-destructive">{t("vectors.metaInvalidInline")}</p>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={!selected || saving || !hasChanges} onClick={resetEditor}>
                {t("vectors.reset")}
              </Button>
              <Button type="button" disabled={saveDisabled} onClick={() => void onSave()}>
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
