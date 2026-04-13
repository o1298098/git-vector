import { Button } from "@/components/ui/button";

type SettingsActionsBarProps = {
  ariaLabel: string;
  saving: boolean;
  reloadLabel: string;
  saveLabel: string;
  savingLabel: string;
  onReload: () => void;
};

export function SettingsActionsBar({
  ariaLabel,
  saving,
  reloadLabel,
  saveLabel,
  savingLabel,
  onReload,
}: SettingsActionsBarProps) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.1)] backdrop-blur supports-[backdrop-filter]:bg-background/85 dark:shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.35)]"
      role="region"
      aria-label={ariaLabel}
    >
      <div className="mx-auto max-w-[1600px] px-4 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-end gap-3">
          <Button type="button" variant="outline" disabled={saving} onClick={onReload}>
            {reloadLabel}
          </Button>
          <Button type="submit" form="settings-form" disabled={saving}>
            {saving ? savingLabel : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
