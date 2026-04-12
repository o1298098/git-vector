import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeMenu } from "@/components/ThemeMenu";
import { useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/i18n/I18nContext";

export function Login() {
  const { t } = useI18n();
  const { ready, uiLoginRequired, username, login } = useAuth();
  const [user, setUser] = useState("admin");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const themeCorner = (
    <div className="fixed right-4 top-4 z-50">
      <ThemeMenu />
    </div>
  );

  if (!ready) {
    return (
      <>
        {themeCorner}
        <div className="flex min-h-screen items-center justify-center text-muted-foreground">{t("login.loading")}</div>
      </>
    );
  }

  if (!uiLoginRequired) {
    return (
      <>
        {themeCorner}
        <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t("login.noAuthTitle")}</CardTitle>
            <CardDescription>{t("login.noAuthDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link to="/">{t("login.enter")}</Link>
            </Button>
          </CardContent>
        </Card>
        </div>
      </>
    );
  }

  if (username) {
    return <Navigate to="/" replace />;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await login(user, password);
    } catch (e2: unknown) {
      setErr(e2 instanceof Error ? e2.message : t("login.fail"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {themeCorner}
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("login.title")}</CardTitle>
          <CardDescription>{t("login.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="user">{t("login.user")}</Label>
              <Input
                id="user"
                autoComplete="username"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pass">{t("login.password")}</Label>
              <Input
                id="pass"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {err ? <p className="text-sm text-destructive">{err}</p> : null}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t("login.submitting") : t("login.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
      </div>
    </>
  );
}
