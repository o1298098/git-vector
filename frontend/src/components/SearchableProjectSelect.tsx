import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nContext";

export type SearchableProjectOption = { project_id: string; project_name?: string | null };

function matchesFilter(p: SearchableProjectOption, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  if (p.project_id.toLowerCase().includes(q)) return true;
  if ((p.project_name || "").toLowerCase().includes(q)) return true;
  return false;
}

type Props = {
  id?: string;
  value: string;
  onChange: (projectId: string) => void;
  projects: SearchableProjectOption[];
  disabled?: boolean;
  loading?: boolean;
};

export function SearchableProjectSelect({ id, value, onChange, projects, disabled, loading }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const selectedDisplay = useMemo(() => {
    if (!value) return { kind: "all" as const };
    const p = projects.find((x) => x.project_id === value);
    if (p) {
      const name = p.project_name?.trim();
      return { kind: "project" as const, id: p.project_id, name: name || undefined };
    }
    return { kind: "raw" as const, id: value };
  }, [value, projects]);

  const filtered = useMemo(() => projects.filter((p) => matchesFilter(p, filter)), [projects, filter]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => filterInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter("");
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setFilter("");
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function pick(idStr: string) {
    onChange(idStr);
    setOpen(false);
    setFilter("");
  }

  const busy = disabled || loading;

  return (
    <div ref={rootRef} className="relative w-full">
      <Button
        id={id}
        type="button"
        variant="outline"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id ?? "project-select"}-listbox`}
        disabled={busy}
        className={cn(
          "h-auto min-h-9 w-full justify-between gap-2 py-2 font-normal",
          !value && "text-muted-foreground",
        )}
        onClick={() => !busy && setOpen((o) => !o)}
      >
        {loading ? (
          <span className="truncate text-left">{t("projectSelect.loading")}</span>
        ) : selectedDisplay.kind === "all" ? (
          <span className="truncate text-left">{t("projectSelect.all")}</span>
        ) : selectedDisplay.kind === "raw" ? (
          <span className="truncate text-left">{selectedDisplay.id}</span>
        ) : (
          <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
            <span className="w-full truncate">{selectedDisplay.id}</span>
            {selectedDisplay.name ? (
              <span className="w-full truncate text-xs text-muted-foreground">{selectedDisplay.name}</span>
            ) : null}
          </span>
        )}
        <ChevronsUpDown className="ml-2 size-4 shrink-0 self-center opacity-50" aria-hidden />
      </Button>

      {open && !busy ? (
        <div
          id={`${id ?? "project-select"}-listbox`}
          role="listbox"
          className="absolute z-50 mt-1 flex max-h-72 w-full flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="border-b p-2">
            <Input
              ref={filterInputRef}
              type="search"
              placeholder={t("projectSelect.filterPh")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8"
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
          <ul className="max-h-52 overflow-y-auto p-1" role="presentation">
            <li role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={value === ""}
                className={cn(
                  "flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left text-sm",
                  value === "" ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                )}
                onClick={() => pick("")}
              >
                <Check
                  className={cn("mt-0.5 size-4 shrink-0", value === "" ? "opacity-100" : "opacity-0")}
                  aria-hidden
                />
                <span>{t("projectSelect.all")}</span>
              </button>
            </li>
            {filtered.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">{t("projectSelect.noMatch")}</li>
            ) : (
              filtered.map((p) => {
                const selected = p.project_id === value;
                return (
                  <li key={p.project_id} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left text-sm",
                        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                      )}
                      onClick={() => pick(p.project_id)}
                    >
                      <Check
                        className={cn("mt-0.5 size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium leading-tight">{p.project_id}</span>
                        {p.project_name?.trim() ? (
                          <span
                            className={cn(
                              "mt-0.5 block truncate text-xs leading-tight",
                              selected ? "text-accent-foreground/80" : "text-muted-foreground",
                            )}
                          >
                            {p.project_name.trim()}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
