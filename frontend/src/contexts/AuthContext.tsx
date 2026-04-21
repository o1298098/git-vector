import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { apiFetch, apiJson, getToken, onUnauthorized, setToken } from "@/lib/api";

type AuthState = {
  ready: boolean;
  uiLoginRequired: boolean;
  username: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [uiLoginRequired, setUiLoginRequired] = useState(false);
  const [username, setUsername] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setUsername(null);
      return;
    }
    const res = await apiFetch("/api/auth/me");
    if (res.ok) {
      const data = (await res.json()) as { username: string };
      setUsername(data.username);
    } else {
      setToken(null);
      setUsername(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await apiJson<{ ui_login_required: boolean }>("/api/auth/status");
        if (cancelled) return;
        setUiLoginRequired(status.ui_login_required);
        if (!status.ui_login_required) {
          setUsername("guest");
          setReady(true);
          return;
        }
        await refreshMe();
      } catch {
        if (!cancelled) {
          setUiLoginRequired(true);
          setUsername(null);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshMe]);

  useEffect(() => {
    if (!uiLoginRequired) return;
    return onUnauthorized(() => {
      setUsername(null);
    });
  }, [uiLoginRequired]);

  const login = useCallback(async (user: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password }),
    });
    if (!res.ok) {
      let msg = "登录失败";
      try {
        const j = await res.json();
        if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const data = (await res.json()) as { access_token: string };
    setToken(data.access_token);
    await refreshMe();
  }, [refreshMe]);

  const logout = useCallback(() => {
    setToken(null);
    setUsername(null);
  }, []);

  const value = useMemo(
    () => ({
      ready,
      uiLoginRequired,
      username,
      login,
      logout,
      refreshMe,
    }),
    [ready, uiLoginRequired, username, login, logout, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
