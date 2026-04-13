import { Save } from "lucide-react";
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

export function VectorsEditorPanel({
  selectedId,
  hasChanges,
  contentMode,
  editContent,
  editMeta,
  saveDisabled,
  saving,
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

  return (
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
        <CardDescription className="font-mono text-xs">{selectedId ?? t("vectors.editorEmpty")}</CardDescription>
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
                disabled={!selectedId}
                onClick={() => onContentModeChange("edit")}
              >
                {t("vectors.contentModeEdit")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={contentMode === "preview" ? "secondary" : "ghost"}
                disabled={!selectedId}
                onClick={() => onContentModeChange("preview")}
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
                onChange={(value: string | undefined) => onEditContentChange(value ?? "")}
                options={{
                  ...contentEditorOptions,
                  minimap: { enabled: false },
                  readOnly: !selectedId || saving,
                }}
              />
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

        <div className="flex min-h-0 flex-col space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="vector-meta">{t("vectors.metaLabel")}</Label>
            <Button type="button" variant="ghost" size="sm" disabled={!selectedId || saving || !metaValid} onClick={onFormatMeta}>
              {t("vectors.formatMeta")}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
            <Editor
              height="100%"
              language="json"
              theme={editorTheme}
              value={editMeta}
              onChange={(value: string | undefined) => onEditMetaChange(value ?? "")}
              options={{ ...metaEditorOptions, readOnly: !selectedId || saving }}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("vectors.metaHint")}</p>
          {!metaValid ? <p className="text-xs text-destructive">{t("vectors.metaInvalidInline")}</p> : null}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={!selectedId || saving || !hasChanges} onClick={onReset}>
            {t("vectors.reset")}
          </Button>
          <Button type="button" disabled={saveDisabled} onClick={onSave}>
            <Save className="mr-1 size-4" />
            {saving ? t("vectors.saving") : t("vectors.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
