import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import hljsDarkUrl from "highlight.js/styles/github-dark.css?url";
import hljsLightUrl from "highlight.js/styles/github.css?url";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "gv_theme";

function readStored(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

function subscribeSystem(callback: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function getSystemDarkSnapshot() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getServerSnapshot() {
  return false;
}

type Ctx = {
  preference: ThemePreference;
  setTheme: (p: ThemePreference) => void;
  /** 实际是否深色（已解析 system） */
  resolvedDark: boolean;
};

const ThemeContext = createContext<Ctx | null>(null);

function syncHljsStylesheet(dark: boolean) {
  const id = "gv-hljs-theme";
  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = dark ? hljsDarkUrl : hljsLightUrl;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    typeof window !== "undefined" ? readStored() : "system",
  );

  const systemDark = useSyncExternalStore(subscribeSystem, getSystemDarkSnapshot, getServerSnapshot);

  const resolvedDark = preference === "dark" || (preference === "system" && systemDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedDark);
    syncHljsStylesheet(resolvedDark);
  }, [resolvedDark]);

  const setTheme = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    () => ({ preference, setTheme, resolvedDark }),
    [preference, setTheme, resolvedDark],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
