import { useEffect, useRef, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { useTheme, type ThemePreference } from "@/theme/ThemeContext";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemePreference; Icon: typeof Sun; labelKey: string }[] = [
  { value: "light", Icon: Sun, labelKey: "layout.themeLight" },
  { value: "dark", Icon: Moon, labelKey: "layout.themeDark" },
  { value: "system", Icon: Monitor, labelKey: "layout.themeSystem" },
];

export function ThemeMenu() {
  const { t } = useI18n();
  const { preference, setTheme, resolvedDark } = useTheme();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const TriggerIcon = resolvedDark ? Moon : Sun;

  return (
    <div ref={menuRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0"
        aria-label={t("layout.themeAria")}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((o) => !o)}
      >
        <TriggerIcon className="size-4" aria-hidden />
      </Button>
      {open ? (
        <div
          className="absolute right-0 top-full z-[60] mt-1 min-w-[11rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          role="listbox"
          aria-label={t("layout.themeAria")}
        >
          {OPTIONS.map(({ value, Icon, labelKey }) => (
            <button
              key={value}
              type="button"
              role="option"
              aria-selected={preference === value}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm transition-colors",
                preference === value ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted",
              )}
              onClick={() => {
                setTheme(value);
                setOpen(false);
              }}
            >
              <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
              <span className="flex min-w-0 flex-1">{t(labelKey)}</span>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {preference === value ? <Check className="size-3.5" aria-hidden /> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
