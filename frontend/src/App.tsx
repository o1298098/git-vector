import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/i18n/I18nContext";
import { Layout } from "@/components/Layout";
import { Dashboard } from "@/pages/dashboard";
import { Enqueue } from "@/pages/enqueue";
import { Jobs } from "@/pages/jobs";
import { Login } from "@/pages/login";
import { CodeChat } from "@/pages/code-chat";
import { Search } from "@/pages/search";
import { Settings } from "@/pages/settings";
import { Vectors } from "@/pages/vectors";
import { LlmUsage } from "@/pages/llm-usage";

function RequireAuth() {
  const { ready, uiLoginRequired, username } = useAuth();
  const { t } = useI18n();
  const loc = useLocation();

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">{t("app.loading")}</div>
    );
  }
  if (uiLoginRequired && !username) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return <Outlet />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="search" element={<Search />} />
          <Route path="chat" element={<CodeChat />} />
          <Route path="jobs" element={<Jobs />} />
          <Route path="usage" element={<LlmUsage />} />
          <Route path="vectors" element={<Vectors />} />
          <Route path="enqueue" element={<Enqueue />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter basename="/admin">
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
