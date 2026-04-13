import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/i18n/I18nContext";
import { LoginFormCard } from "./components/LoginFormCard";
import { LoginNoAuthCard } from "./components/LoginNoAuthCard";
import { LoginScene } from "./components/LoginScene";
import { LoginThemeCorner } from "./components/LoginThemeCorner";

export function Login() {
  const { t } = useI18n();
  const { ready, uiLoginRequired, username, login } = useAuth();
  const [user, setUser] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!ready) {
    return (
      <>
        <LoginThemeCorner />
        <LoginScene>
          <div className="text-sm text-slate-700 dark:text-slate-200">
            {t("login.loading")}
          </div>
        </LoginScene>
      </>
    );
  }

  if (!uiLoginRequired) {
    return (
      <>
        <LoginThemeCorner />
        <LoginScene>
          <LoginNoAuthCard title={t("login.noAuthTitle")} description={t("login.noAuthDesc")} enterLabel={t("login.enter")} />
        </LoginScene>
      </>
    );
  }

  if (username) {
    return <Navigate to="/" replace />;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(user, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("login.fail"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <LoginThemeCorner />
      <LoginScene>
        <LoginFormCard
          user={user}
          password={password}
          loading={loading}
          error={error}
          onUserChange={setUser}
          onPasswordChange={setPassword}
          onSubmit={onSubmit}
          text={{
            title: t("login.title"),
            subtitle: t("login.subtitle"),
            userLabel: t("login.user"),
            passwordLabel: t("login.password"),
            submit: t("login.submit"),
            submitting: t("login.submitting"),
          }}
        />
      </LoginScene>
    </>
  );
}
