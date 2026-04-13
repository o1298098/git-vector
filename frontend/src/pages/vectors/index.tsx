import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiJson } from "@/lib/api";
import { useI18n } from "@/i18n/I18nContext";
import { useTheme } from "@/theme/ThemeContext";
import { VectorsEditorPanel } from "./components/VectorsEditorPanel";
import { VectorsListPanel } from "./components/VectorsListPanel";
import { PAGE_SIZE, SEARCH_DEBOUNCE_MS, type ProjectOption, type VectorListResp, type VectorRow } from "./types";
import { prettyMeta, stableJson } from "./utils";

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
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(initialQ);
  const [debouncedQ, setDebouncedQ] = useState(initialQ);
  const [selectedId, setSelectedId] = useState("");
  const selected = useMemo(() => rows.find((row) => row.id === selectedId) ?? null, [rows, selectedId]);
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
          const firstProjectId = list[0].project_id;
          setProjectId(firstProjectId);
          setSearchParams({ project_id: firstProjectId }, { replace: true });
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
    const queryProjectId = (searchParams.get("project_id") || "").trim();
    if (queryProjectId && queryProjectId !== projectId) {
      setProjectId(queryProjectId);
      setPage(0);
    }
  }, [searchParams, projectId]);

  useEffect(() => {
    const query = (searchParams.get("q") || "").trim();
    if (query !== searchInput) {
      setSearchInput(query);
      setDebouncedQ(query);
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
    setError(null);
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
      setSelectedId((prevId) => (prevId && data.items.some((item) => item.id === prevId) ? prevId : firstId));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("vectors.loadFail"));
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
    setError(null);
  }, [selected, selectedMetaPretty]);

  const formatMeta = useCallback(() => {
    if (!metaValidation.valid || !metaValidation.parsed) return;
    setEditMeta(prettyMeta(metaValidation.parsed));
  }, [metaValidation]);

  async function onSave() {
    if (!projectId || !selected) return;
    setError(null);
    setOk(null);
    if (!hasChanges) {
      setOk(t("vectors.noChange"));
      return;
    }
    if (!metaValidation.valid || !metaValidation.parsed) {
      setError(t("vectors.metaInvalid"));
      return;
    }
    const metadata = metaValidation.parsed;

    setSaving(true);
    try {
      await apiJson<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/vectors/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ content: editContent, metadata }),
      });
      setOk(t("vectors.saved"));
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("vectors.saveFail"));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    function onKeydown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (saveDisabled) return;
      event.preventDefault();
      void onSave();
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [saveDisabled, projectId, selected, editContent, editMeta]);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>
      ) : null}
      {ok ? <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">{ok}</div> : null}

      <div className="grid gap-4 xl:grid-cols-12">
        <VectorsListPanel
          total={total}
          page={page}
          totalPages={totalPages}
          projectId={projectId}
          projects={projects}
          projectsLoading={projectsLoading}
          searchInput={searchInput}
          rows={rows}
          selectedId={selectedId}
          loading={loading}
          saving={saving}
          onProjectChange={(nextProjectId) => {
            const next = (nextProjectId || "").trim();
            setProjectId(next);
            setPage(0);
            setSearchParams(
              (prev) => {
                const params = new URLSearchParams(prev);
                if (next) params.set("project_id", next);
                else params.delete("project_id");
                return params;
              },
              { replace: true },
            );
          }}
          onSearchChange={setSearchInput}
          onSelectRow={setSelectedId}
          onPrevPage={() => setPage((currentPage) => Math.max(0, currentPage - 1))}
          onNextPage={() => setPage((currentPage) => currentPage + 1)}
        />
        <VectorsEditorPanel
          selectedId={selected ? selected.id : null}
          hasChanges={hasChanges}
          contentMode={contentMode}
          editContent={editContent}
          editMeta={editMeta}
          saveDisabled={saveDisabled}
          saving={saving}
          resolvedDark={resolvedDark}
          editorTheme={editorTheme}
          contentEditorOptions={contentEditorOptions}
          metaEditorOptions={metaEditorOptions}
          metaValid={metaValidation.valid}
          onContentModeChange={setContentMode}
          onEditContentChange={setEditContent}
          onEditMetaChange={setEditMeta}
          onFormatMeta={formatMeta}
          onReset={resetEditor}
          onSave={() => void onSave()}
        />
      </div>
    </div>
  );
}
