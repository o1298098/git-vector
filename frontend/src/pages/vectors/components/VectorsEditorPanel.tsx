import { useEffect, useState } from "react";
import { Braces, Expand, Eye, Pencil, Save, X } from "lucide-react";
import Editor from "@monaco-editor/react";
import XMarkdown from "@ant-design/x-markdown";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { MarkdownPre } from "@/pages/code-chat/components/MarkdownPre";
import { useI18n } from "@/i18n/I18nContext";

type VectorsEditorPanelProps = {
  selectedId: string | null;
  hasChanges: boolean;
  contentMode: "edit" | "preview";
  editContent: string;
  editMeta: string;
  saveDisabled: boolean;
  saving: boolean;
  loading: boolean;
  resolvedDark: boolean;
  editorTheme: string;
  contentEditorOptions: object;
  metaEditorOptions: object;
  metaValid: boolean;
  onContentModeChange: (mode: "edit" | "preview") => void;
  onEditContentChange: (value: string) => void;
  onEditMetaChange: (value: string) => void;
  onFormatMeta: () => void;
  onReset: () => void;
  onSave: () => void;
};

type ExpandedEditorType = "content" | "meta" | null;

function CodeEditorSkeleton({ lines, showMinimap = false }: { lines: number; showMinimap?: boolean }) {
  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-md border bg-background">
      <div className="flex w-10 shrink-0 flex-col gap-2 border-r bg-muted/20 px-2 py-3">
        {Array.from({ length: lines }).map((_, index) => (
          <div key={`line-number-${index}`} className="h-3 w-4 animate-pulse rounded bg-muted" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 gap-3 px-3 py-3">
        <div className="min-w-0 flex-1 space-y-2">
          {Array.from({ length: lines }).map((_, index) => (
            <div
              key={`line-content-${index}`}
              className="h-3 animate-pulse rounded bg-muted"
              style={{ width: `${92 - (index % 5) * 11}%` }}
            />
          ))}
        </div>
        {showMinimap ? (
          <div className="hidden w-14 shrink-0 rounded-sm border border-border/60 bg-muted/20 p-1.5 lg:block">
            <div className="space-y-1">
              {Array.from({ length: Math.max(8, lines - 1) }).map((_, index) => (
                <div
                  key={`minimap-${index}`}
                  className="h-1 animate-pulse rounded bg-muted/80"
                  style={{ width: `${88 - (index % 4) * 12}%` }}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function VectorsEditorSkeleton() {
  return (
    <div role="status" aria-hidden className="grid min-h-0 min-w-0 flex-1 grid-rows-[1fr_1fr_auto] gap-4">
      <div className="flex min-h-0 min-w-0 flex-col space-y-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          <div className="flex items-center gap-1">
            <div className="h-8 w-12 animate-pulse rounded-md bg-muted" />
            <div className="h-8 w-12 animate-pulse rounded-md bg-muted" />
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <CodeEditorSkeleton lines={12} showMinimap />
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-col space-y-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="h-4 w-28 animate-pulse rounded bg-muted" />
          <div className="h-8 w-20 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <CodeEditorSkeleton lines={10} />
        </div>
        <div className="h-3 w-48 animate-pulse rounded bg-muted" />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <div className="h-9 w-20 animate-pulse rounded-md bg-muted" />
        <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
      </div>
    </div>
  );
}

function EditorActions({ children }: { children: React.ReactNode }) {
  return <div className="inline-flex items-center gap-1">{children}</div>;
}

function ExpandedEditorDialog({
  open,
  title,
  value,
  language,
  editorTheme,
  editorOptions,
  readOnly,
  onClose,
  onChange,
  actions,
}: {
  open: boolean;
  title: string;
  value: string;
  language: "markdown" | "json";
  editorTheme: string;
  editorOptions: object;
  readOnly: boolean;
  onClose: () => void;
  onChange: (value: string) => void;
  actions?: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]">
      <div className="flex h-[min(92vh,980px)] w-[min(96vw,1400px)] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{title}</h2>
          </div>
          <div className="flex items-center gap-2">
            {actions}
            <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close expanded editor">
              <X className="size-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 p-4">
          <div className="h-full overflow-hidden rounded-xl border">
            <Editor
              height="100%"
              language={language}
              theme={editorTheme}
              loading={null}
              value={value}
              onChange={(nextValue: string | undefined) => onChange(nextValue ?? "")}
              options={{ ...editorOptions, readOnly }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function VectorsEditorPanel({
  selectedId,
  hasChanges,
  contentMode,
  editContent,
  editMeta,
  saveDisabled,
  saving,
  loading,
  resolvedDark,
  editorTheme,
  contentEditorOptions,
  metaEditorOptions,
  metaValid,
  onContentModeChange,
  onEditContentChange,
  onEditMetaChange,
  onFormatMeta,
  onReset,
  onSave,
}: VectorsEditorPanelProps) {
  const { t } = useI18n();
  const [useSimpleEditor, setUseSimpleEditor] = useState(false);
  const [expandedEditor, setExpandedEditor] = useState<ExpandedEditorType>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setUseSimpleEditor(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const showSkeleton = loading && !selectedId;

  return (
    <Card className="flex h-[min(84vh,860px)] min-w-0 flex-col">
      <CardHeader className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="text-lg">{t("vectors.editorTitle")}</CardTitle>
          {hasChanges ? (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
              {t("vectors.unsaved")}
            </span>
          ) : null}
        </div>
        <CardDescription className="min-w-0 break-all font-mono text-xs">{selectedId ?? t("vectors.editorEmpty")}</CardDescription>
        <CardDescription className="text-xs text-muted-foreground">{t("vectors.saveShortcut")}</CardDescription>
      </CardHeader>
      <CardContent className="grid min-h-0 min-w-0 flex-1 grid-rows-[1fr_1fr_auto] gap-4">
        {showSkeleton ? (
          <VectorsEditorSkeleton />
        ) : (
          <>
            <ExpandedEditorDialog
              open={expandedEditor === "content"}
              title={`${t("vectors.contentLabel")} (${selectedId ?? ""})`}
              value={editContent}
              language="markdown"
              editorTheme={editorTheme}
              editorOptions={{ ...contentEditorOptions, minimap: { enabled: true } }}
              readOnly={!selectedId || saving}
              onClose={() => setExpandedEditor(null)}
              onChange={onEditContentChange}
            />
            <ExpandedEditorDialog
              open={expandedEditor === "meta"}
              title={`${t("vectors.metaLabel")} (${selectedId ?? ""})`}
              value={editMeta}
              language="json"
              editorTheme={editorTheme}
              editorOptions={metaEditorOptions}
              readOnly={!selectedId || saving}
              onClose={() => setExpandedEditor(null)}
              onChange={onEditMetaChange}
              actions={
                <EditorActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-md"
                    disabled={!selectedId || saving || !metaValid}
                    onClick={onFormatMeta}
                    aria-label={t("vectors.formatMeta")}
                    title={t("vectors.formatMeta")}
                  >
                    <Braces className="size-4" />
                  </Button>
                </EditorActions>
              }
            />
            <div className="flex min-h-0 min-w-0 flex-col space-y-2">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <Label htmlFor="vector-content">{t("vectors.contentLabel")}</Label>
                <EditorActions>
                  <Button
                    type="button"
                    size="icon"
                    variant={contentMode === "edit" ? "secondary" : "ghost"}
                    className="size-8 rounded-md"
                    disabled={!selectedId}
                    onClick={() => onContentModeChange("edit")}
                    aria-label={t("vectors.contentModeEdit")}
                    title={t("vectors.contentModeEdit")}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant={contentMode === "preview" ? "secondary" : "ghost"}
                    className="size-8 rounded-md"
                    disabled={!selectedId}
                    onClick={() => onContentModeChange("preview")}
                    aria-label={t("vectors.contentModePreview")}
                    title={t("vectors.contentModePreview")}
                  >
                    <Eye className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8 rounded-md text-muted-foreground"
                    disabled={!selectedId}
                    onClick={() => setExpandedEditor("content")}
                    aria-label="Open expanded content editor"
                    title="Open expanded content editor"
                  >
                    <Expand className="size-4" />
                  </Button>
                </EditorActions>
              </div>
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border">
                {contentMode === "edit" ? (
                  useSimpleEditor ? (
                    <textarea
                      id="vector-content"
                      value={editContent}
                      readOnly={!selectedId || saving}
                      onChange={(event) => onEditContentChange(event.target.value)}
                      className="gv-vectors-plain-editor h-full w-full resize-none bg-transparent p-3 font-mono text-xs leading-5 outline-none"
                      spellCheck={false}
                    />
                  ) : (
                    <Editor
                      height="100%"
                      language="markdown"
                      theme={editorTheme}
                      loading={null}
                      value={editContent}
                      onChange={(value: string | undefined) => onEditContentChange(value ?? "")}
                      options={{
                        ...contentEditorOptions,
                        minimap: { enabled: false },
                        readOnly: !selectedId || saving,
                      }}
                    />
                  )
                ) : (
                  <div className="h-full overflow-auto p-3">
                    {selectedId ? (
                      <div className={`gv-code-chat-bubbles ${resolvedDark ? "x-markdown-dark" : "x-markdown-light"}`}>
                        <XMarkdown content={editContent} components={{ pre: MarkdownPre }} />
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">{t("vectors.previewEmpty")}</p>
                    )}
                  </div>
                )}
              </div>
              {contentMode === "preview" ? <p className="text-xs text-muted-foreground">{t("vectors.previewHint")}</p> : null}
            </div>

            <div className="flex min-h-0 min-w-0 flex-col space-y-2">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <Label htmlFor="vector-meta">{t("vectors.metaLabel")}</Label>
                <EditorActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-md"
                    disabled={!selectedId || saving || !metaValid}
                    onClick={onFormatMeta}
                    aria-label={t("vectors.formatMeta")}
                    title={t("vectors.formatMeta")}
                  >
                    <Braces className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8 rounded-md text-muted-foreground"
                    disabled={!selectedId}
                    onClick={() => setExpandedEditor("meta")}
                    aria-label="Open expanded metadata editor"
                    title="Open expanded metadata editor"
                  >
                    <Expand className="size-4" />
                  </Button>
                </EditorActions>
              </div>
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border">
                {useSimpleEditor ? (
                  <textarea
                    id="vector-meta"
                    value={editMeta}
                    readOnly={!selectedId || saving}
                    onChange={(event) => onEditMetaChange(event.target.value)}
                    className="gv-vectors-plain-editor h-full w-full resize-none bg-transparent p-3 font-mono text-xs leading-5 outline-none"
                    spellCheck={false}
                  />
                ) : (
                  <Editor
                    height="100%"
                    language="json"
                    theme={editorTheme}
                    loading={null}
                    value={editMeta}
                    onChange={(value: string | undefined) => onEditMetaChange(value ?? "")}
                    options={{ ...metaEditorOptions, readOnly: !selectedId || saving }}
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t("vectors.metaHint")}</p>
              {!metaValid ? <p className="text-xs text-destructive">{t("vectors.metaInvalidInline")}</p> : null}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" disabled={!selectedId || saving || !hasChanges} onClick={onReset}>
                {t("vectors.reset")}
              </Button>
              <Button type="button" disabled={saveDisabled} onClick={onSave}>
                <Save className="mr-1 size-4" />
                {saving ? t("vectors.saving") : t("vectors.save")}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
