import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Check, Home, Languages, ListOrdered, LogOut, MessageCircle, Search, Settings } from "lucide-react";
import { ThemeMenu } from "@/components/ThemeMenu";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";

export function Layout() {
  const { pathname } = useLocation();
  const isChatRoute = pathname === "/chat";
  const { uiLoginRequired, username, logout } = useAuth();
  const { locale, setLocale, t } = useI18n();
  const [langOpen, setLangOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!langOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) setLangOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLangOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [langOpen]);

  const nav: {
    to: string;
    labelKey: string;
    icon: typeof Home;
    end?: boolean;
  }[] = [
    { to: "/", labelKey: "nav.overview", icon: Home, end: true },
    { to: "/search", labelKey: "nav.search", icon: Search },
    { to: "/chat", labelKey: "nav.chat", icon: MessageCircle },
    { to: "/jobs", labelKey: "nav.jobs", icon: ListOrdered },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 w-full max-w-none items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Link to="/" className="min-w-0 shrink-0 pr-1 sm:pr-2">
            <div className="font-semibold leading-tight text-foreground">{t("layout.brandTitle")}</div>
            <div className="hidden text-xs text-muted-foreground sm:block">{t("layout.brandSub")}</div>
          </Link>

          <nav
            className="flex min-w-0 flex-1 items-center justify-start gap-0.5 overflow-x-auto sm:gap-1"
            aria-label="主导航"
          >
            {nav.map(({ to, labelKey, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-2 text-sm font-medium transition-colors sm:px-3",
                    isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                <Icon className="size-4" aria-hidden />
                {t(labelKey)}
              </NavLink>
            ))}
          </nav>

          <div className="flex shrink-0 items-center justify-end gap-1.5 border-l border-border/60 pl-2 sm:gap-2 sm:pl-3 md:pl-4">
            <ThemeMenu />
            <div ref={langMenuRef} className="relative">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 shrink-0"
                aria-label={t("layout.uiLang")}
                aria-expanded={langOpen}
                aria-haspopup="listbox"
                onClick={() => setLangOpen((o) => !o)}
              >
                <Languages className="size-4" aria-hidden />
              </Button>
              {langOpen ? (
                <div
                  className="absolute right-0 top-full z-[60] mt-1 min-w-[10rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
                  role="listbox"
                  aria-label={t("layout.uiLang")}
                >
                  {(
                    [
                      { code: "zh" as const, label: t("layout.langZh") },
                      { code: "en" as const, label: t("layout.langEn") },
                    ] as const
                  ).map(({ code, label }) => (
                    <button
                      key={code}
                      type="button"
                      role="option"
                      aria-selected={locale === code}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm transition-colors",
                        locale === code ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted",
                      )}
                      onClick={() => {
                        setLocale(code);
                        setLangOpen(false);
                      }}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        {locale === code ? <Check className="size-3.5" aria-hidden /> : null}
                      </span>
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <NavLink
              to="/settings"
              title={t("nav.settings")}
              className={({ isActive }) =>
                cn(
                  "inline-flex size-9 shrink-0 items-center justify-center rounded-md transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )
              }
              aria-label={t("nav.settings")}
            >
              <Settings className="size-4" aria-hidden />
            </NavLink>
            {uiLoginRequired ? (
              <>
                <span className="hidden max-w-[120px] truncate text-xs text-muted-foreground sm:inline" title={username ?? ""}>
                  {username}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0"
                  onClick={() => logout()}
                  aria-label={t("layout.logoutAria")}
                >
                  <LogOut className="size-4" aria-hidden />
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">{t("layout.noLogin")}</span>
            )}
          </div>
        </div>
      </header>

      <main
        className={cn(
          "flex-1",
          isChatRoute ? "flex min-h-0 flex-col p-0" : "px-4 py-6 sm:px-6 sm:py-8",
        )}
      >
        <div
          className={cn(
            "mx-auto w-full",
            isChatRoute
              ? "flex h-[calc(100dvh-3.5rem)] max-w-none min-h-0 flex-1 flex-col"
              : "max-w-[1600px]",
          )}
        >
          <Outlet />
        </div>
      </main>
    </div>
  );
}
