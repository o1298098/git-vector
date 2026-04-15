import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { type ProjectRow } from "../types";

type DashboardDialogsProps = {
  reindexTarget: ProjectRow | null;
  deleteTarget: ProjectRow | null;
  renameTarget: ProjectRow | null;
  renameInput: string;
  reindexingId: string | null;
  deletingId: string | null;
  renamingId: string | null;
  onRenameInputChange: (value: string) => void;
  onCloseReindexDialog: () => void;
  onCloseDeleteDialog: () => void;
  onCloseRenameDialog: () => void;
  onConfirmReindex: (project: ProjectRow) => void;
  onConfirmDelete: (project: ProjectRow) => void;
  onConfirmRename: (project: ProjectRow) => void;
};

export function DashboardDialogs({
  reindexTarget,
  deleteTarget,
  renameTarget,
  renameInput,
  reindexingId,
  deletingId,
  renamingId,
  onRenameInputChange,
  onCloseReindexDialog,
  onCloseDeleteDialog,
  onCloseRenameDialog,
  onConfirmReindex,
  onConfirmDelete,
  onConfirmRename,
}: DashboardDialogsProps) {
  const { t } = useI18n();

  return (
    <>
      <AlertDialog open={renameTarget !== null} onOpenChange={(open) => !open && onCloseRenameDialog()}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dashboard.renameDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="text-left">{t("dashboard.renameDialogDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          {renameTarget ? (
            <div className="space-y-2 py-1">
              <p className="truncate font-mono text-xs text-muted-foreground" title={renameTarget.project_id}>
                {renameTarget.project_id}
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="gv-rename-project-input" className="text-xs">
                  {t("dashboard.renameLabel")}
                </Label>
                <Input
                  id="gv-rename-project-input"
                  value={renameInput}
                  onChange={(e) => onRenameInputChange(e.target.value)}
                  placeholder={t("dashboard.renamePlaceholder")}
                  maxLength={200}
                  disabled={renamingId !== null}
                  autoComplete="off"
                />
              </div>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={renamingId !== null}>{t("dashboard.renameCancel")}</AlertDialogCancel>
            <Button type="button" disabled={renamingId !== null} onClick={() => renameTarget && onConfirmRename(renameTarget)}>
              {renamingId !== null ? t("dashboard.renameSaving") : t("dashboard.renameSave")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={reindexTarget !== null} onOpenChange={(open) => !open && onCloseReindexDialog()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dashboard.reindexDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {reindexTarget
                ? t("dashboard.reindexConfirm", {
                    id: (reindexTarget.project_name ?? "").trim() || reindexTarget.project_id,
                  })
                : "\u00a0"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reindexingId !== null}>{t("dashboard.reindexCancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={reindexingId !== null}
              onClick={() => {
                if (reindexTarget) onConfirmReindex(reindexTarget);
              }}
            >
              {reindexingId !== null ? "…" : t("dashboard.reindex")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && onCloseDeleteDialog()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dashboard.deleteDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? t("dashboard.deleteConfirm", {
                    id: (deleteTarget.project_name ?? "").trim() || deleteTarget.project_id,
                  })
                : "\u00a0"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingId !== null}>{t("dashboard.deleteCancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingId !== null}
              className={cn(buttonVariants({ variant: "destructive" }))}
              onClick={() => {
                if (deleteTarget) onConfirmDelete(deleteTarget);
              }}
            >
              {deletingId !== null ? "…" : t("dashboard.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
