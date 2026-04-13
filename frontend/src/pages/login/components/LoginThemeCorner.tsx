import { useEffect, useRef, useState } from "react";
import { ThemeMenu } from "@/components/ThemeMenu";
import { Check, Languages } from "lucide-react";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";

export function LoginThemeCorner() {
  const { locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="fixed right-4 top-4 z-50 flex items-center gap-2">
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="inline-flex size-9 items-center justify-center rounded-full bg-transparent text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={locale === "zh" ? "切换语言" : "Switch language"}
          title={locale === "zh" ? "切换语言" : "Switch language"}
        >
          <Languages className="size-4" />
        </button>
        {open ? (
          <div
            className="absolute right-0 top-full z-[60] mt-1 min-w-[8rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
            role="listbox"
            aria-label={locale === "zh" ? "语言选择" : "Language selector"}
          >
            {(["zh", "en"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="option"
                aria-selected={locale === value}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm transition-colors",
                  locale === value ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted",
                )}
                onClick={() => {
                  setLocale(value);
                  setOpen(false);
                }}
              >
                <span className="flex min-w-0 flex-1">{value === "zh" ? "中文" : "English"}</span>
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {locale === value ? <Check className="size-3.5" aria-hidden /> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <ThemeMenu />
    </div>
  );
}
