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
import { buttonVariants } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { type ProjectRow } from "../types";

type DashboardDialogsProps = {
  reindexTarget: ProjectRow | null;
  deleteTarget: ProjectRow | null;
  reindexingId: string | null;
  deletingId: string | null;
  onCloseReindexDialog: () => void;
  onCloseDeleteDialog: () => void;
  onConfirmReindex: (project: ProjectRow) => void;
  onConfirmDelete: (project: ProjectRow) => void;
};

export function DashboardDialogs({
  reindexTarget,
  deleteTarget,
  reindexingId,
  deletingId,
  onCloseReindexDialog,
  onCloseDeleteDialog,
  onConfirmReindex,
  onConfirmDelete,
}: DashboardDialogsProps) {
  const { t } = useI18n();

  return (
    <>
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
