import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

/** 下拉展开方向与高度（避免贴底时被裁切，优先向上弹出） */
type DropdownLayout = {
  side: "above" | "below";
  maxHeight: number;
  /** portaled 时 fixed 定位用 */
  fixed?: { left: number; width: number; top?: number; bottom?: number };
};

type Props = {
  id?: string;
  value: string;
  onChange: (projectId: string) => void;
  projects: SearchableProjectOption[];
  disabled?: boolean;
  loading?: boolean;
  /** 为 true 时用 Portal 挂到 document.body，避免被 Popover/modal 等 overflow 裁切 */
  portaled?: boolean;
  /** 紧凑模式：选中态只显示一行项目 ID，便于工具栏对齐 */
  compact?: boolean;
};

const LISTBOX_Z = 3000;
/** 与 max-h-72 一致，作为理想高度参与翻转判断 */
const PANEL_IDEAL_PX = 288;
const VIEW_MARGIN = 8;
const GAP_PX = 4;

function computeLayout(rootEl: HTMLElement, portaled: boolean): DropdownLayout {
  const r = rootEl.getBoundingClientRect();
  const innerH = window.innerHeight;
  const spaceBelow = innerH - r.bottom - VIEW_MARGIN;
  const spaceAbove = r.top - VIEW_MARGIN;
  /** 下方不够放理想高度且上方更宽裕时，向上展开 */
  const openUp = spaceBelow < PANEL_IDEAL_PX && spaceAbove > spaceBelow;
  const maxHeight = Math.min(PANEL_IDEAL_PX, openUp ? spaceAbove : spaceBelow);

  if (portaled) {
    if (openUp) {
      return {
        side: "above",
        maxHeight,
        fixed: {
          left: r.left,
          width: r.width,
          bottom: innerH - r.top + GAP_PX,
        },
      };
    }
    return {
      side: "below",
      maxHeight,
      fixed: {
        left: r.left,
        width: r.width,
        top: r.bottom + GAP_PX,
      },
    };
  }

  return { side: openUp ? "above" : "below", maxHeight };
}

export function SearchableProjectSelect({
  id,
  value,
  onChange,
  projects,
  disabled,
  loading,
  portaled = false,
  compact = false,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [layout, setLayout] = useState<DropdownLayout | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const listboxId = `${id ?? "project-select"}-listbox`;

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

  const busy = disabled || loading;

  useLayoutEffect(() => {
    if (!open || busy) return;
    const run = () => {
      const el = rootRef.current;
      if (!el) return;
      setLayout(computeLayout(el, portaled));
    };
    run();
    window.addEventListener("scroll", run, true);
    window.addEventListener("resize", run);
    return () => {
      window.removeEventListener("scroll", run, true);
      window.removeEventListener("resize", run);
    };
  }, [open, busy, portaled]);

  useEffect(() => {
    if (!open) {
      setLayout(null);
      return;
    }
    const timer = window.setTimeout(() => filterInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const node = e.target as Node;
      if (rootRef.current?.contains(node) || portalRef.current?.contains(node)) return;
      setOpen(false);
      setFilter("");
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

  const panelClass = cn(
    "flex min-h-0 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md",
    !portaled && "absolute z-50 w-full",
    !portaled && layout?.side === "below" && "top-full mt-1",
    !portaled && layout?.side === "above" && "bottom-full mb-1",
  );

  const listPanel =
    open &&
    !busy &&
    layout &&
    (!portaled || layout.fixed) && (
      <div
        ref={portaled ? portalRef : undefined}
        id={listboxId}
        role="listbox"
        className={panelClass}
        style={
          portaled && layout.fixed
            ? {
                position: "fixed",
                left: layout.fixed.left,
                width: layout.fixed.width,
                zIndex: LISTBOX_Z,
                maxHeight: layout.maxHeight,
                ...(layout.side === "below"
                  ? { top: layout.fixed.top, bottom: "auto" }
                  : { bottom: layout.fixed.bottom, top: "auto" }),
              }
            : !portaled
              ? { maxHeight: layout.maxHeight }
              : undefined
        }
      >
        <div className="shrink-0 border-b p-2">
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
        <ul className="min-h-0 flex-1 overflow-y-auto p-1" role="presentation">
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
    );

  return (
    <div ref={rootRef} className="relative w-full">
      <Button
        id={id}
        type="button"
        variant="outline"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={busy}
        className={cn(
          compact ? "h-9 w-full justify-between gap-2 px-3 py-1 font-normal" : "h-auto min-h-9 w-full justify-between gap-2 py-2 font-normal",
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
        ) : compact ? (
          <span className="truncate text-left" title={selectedDisplay.name ? `${selectedDisplay.id} · ${selectedDisplay.name}` : selectedDisplay.id}>
            {selectedDisplay.id}
          </span>
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

      {portaled && listPanel ? createPortal(listPanel, document.body) : !portaled ? listPanel : null}
    </div>
  );
}
