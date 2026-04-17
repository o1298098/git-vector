import { useEffect, useMemo, useRef, useState } from "react";
import type { StoredChatTurn as ChatTurn } from "@/lib/codeChatStorage";
import { useI18n } from "@/i18n/I18nContext";

type QuickNavItem = {
  id: string;
  label: string;
  seq: number;
};

type CodeChatQuickNavProps = {
  turns: ChatTurn[];
};

function toQuickNavItems(turns: ChatTurn[]): QuickNavItem[] {
  return turns
    .filter((turn) => turn.role === "user" && turn.content.trim())
    .map((turn, index) => {
      const raw = turn.content.replace(/\s+/g, " ").trim();
      const label = raw.length > 72 ? `${raw.slice(0, 72)}...` : raw;
      return { id: turn.id, label, seq: index + 1 };
    });
}

export function CodeChatQuickNav({ turns }: CodeChatQuickNavProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  const items = useMemo(() => toQuickNavItems(turns), [turns]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (items.length === 0) {
      setActiveId("");
      return;
    }
    const currentExists = items.some((item) => item.id === activeId);
    if (!currentExists) setActiveId(items[items.length - 1].id);
  }, [items, activeId]);

  useEffect(() => {
    if (items.length === 0) return;
    const container = document.querySelector(".gv-code-chat-bubbles .ant-bubble-list-scroll-box") as HTMLElement | null;
    if (!container) return;
    let raf = 0;
    const pickActive = () => {
      const viewport = container.getBoundingClientRect();
      const targetY = viewport.top + viewport.height * 0.45;
      let pickedId: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const item of items) {
        const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(item.id) : item.id;
        const el = document.querySelector(`.gv-code-chat-turn-${escaped}`) as HTMLElement | null;
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const center = rect.top + rect.height / 2;
        const distance = Math.abs(center - targetY);
        if (distance < bestDistance) {
          bestDistance = distance;
          pickedId = item.id;
        }
      }
      if (pickedId) setActiveId((prev) => (prev === pickedId ? prev : pickedId));
    };
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(pickActive);
    };
    pickActive();
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [items]);

  useEffect(() => {
    if (!open) {
      setShowTopFade(false);
      setShowBottomFade(false);
      return;
    }
    const list = listRef.current;
    if (!list) return;

    const updateFade = () => {
      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      if (maxScrollTop <= 1) {
        setShowTopFade(false);
        setShowBottomFade(false);
        return;
      }
      setShowTopFade(list.scrollTop > 2);
      setShowBottomFade(list.scrollTop < maxScrollTop - 2);
    };

    updateFade();
    list.addEventListener("scroll", updateFade, { passive: true });
    window.addEventListener("resize", updateFade);
    return () => {
      list.removeEventListener("scroll", updateFade);
      window.removeEventListener("resize", updateFade);
    };
  }, [open, items]);

  const scrollToTurn = (turnId: string) => {
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(turnId) : turnId;
    const el = document.querySelector(`.gv-code-chat-turn-${escaped}`);
    if (!el) return;
    setActiveId(turnId);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setOpen(false);
  };

  if (items.length <= 1) return null;

  return (
    <div className="pointer-events-none fixed right-2.5 top-1/2 z-40 hidden -translate-y-1/2 lg:block">
      <div className="pointer-events-auto relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
        <div className="flex w-8 flex-col items-end gap-2 pr-0" aria-label={t("chat.quickNavOpenAria")} role="navigation">
          {items.map((item) => {
            const isActive = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                className={`h-[2px] w-4 rounded-full transition-colors ${
                  isActive ? "bg-foreground/90" : "bg-foreground/35 hover:bg-foreground/55"
                }`}
                title={`#${item.seq} ${item.label}`}
                onClick={() => scrollToTurn(item.id)}
              />
            );
          })}
        </div>
        {open ? (
          <div className="fixed right-0 top-1/2 z-50 w-72 -translate-y-1/2 rounded-xl bg-background/96 p-2 shadow-2xl backdrop-blur-md">
            <div className="relative">
              {showTopFade ? <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 rounded-t-xl bg-gradient-to-b from-background/95 via-background/70 to-transparent" /> : null}
              {showBottomFade ? <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 rounded-b-xl bg-gradient-to-t from-background/95 via-background/70 to-transparent" /> : null}
              <ul ref={listRef} className="max-h-[60vh] space-y-1 overflow-y-auto overflow-x-hidden px-1 py-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                        item.id === activeId ? "bg-primary/12 text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                      }`}
                      onClick={() => scrollToTurn(item.id)}
                      title={item.label}
                    >
                      <span className="inline-flex w-full min-w-0 items-center gap-1">
                        <span className="shrink-0 text-xs text-muted-foreground/80">#{item.seq}</span>
                        <span className="min-w-0 truncate align-middle">{item.label}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
