import { useCallback, useEffect, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/I18nContext";
import { SettingsActionsBar } from "./components/SettingsActionsBar";
import { SettingsSideNav } from "./components/SettingsSideNav";
import { SourceBadge } from "./components/SourceBadge";
import { EMPTY_FORM, SETTINGS_SECTIONS, type FormState, type SettingsResponse } from "./types";
import { buildPatch, respToForm } from "./utils";

export function Settings() {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [initial, setInitial] = useState<FormState>(EMPTY_FORM);
  const [envDefaults, setEnvDefaults] = useState<SettingsResponse["env_defaults"]>({});
  const [fieldSource, setFieldSource] = useState<Record<string, string>>({});
  const [revertSecret, setRevertSecret] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string>(SETTINGS_SECTIONS[0]?.id ?? "settings-gitlab");

  const load = useCallback(async () => {
    setError(null);
    setOk(null);
    setLoading(true);
    try {
      const data = await apiJson<SettingsResponse>("/api/admin/settings");
      const normalizedForm = respToForm(data);
      setForm(normalizedForm);
      setInitial(normalizedForm);
      setEnvDefaults(data.env_defaults);
      const sources: Record<string, string> = {};
      for (const [key, value] of Object.entries(data.fields)) {
        if (value?.source) sources[key] = value.source;
      }
      setFieldSource(sources);
      setRevertSecret({});
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("settings.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loading) return;
    const sectionElements = SETTINGS_SECTIONS.map((section) => document.getElementById(section.id)).filter(
      (element): element is HTMLElement => Boolean(element),
    );
    if (sectionElements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          const id = visible[0].target.id;
          if (id) setActiveSection(id);
        }
      },
      { root: null, rootMargin: "-10% 0px -52% 0px", threshold: [0, 0.05, 0.15] },
    );
    sectionElements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [loading]);

  function scrollToSection(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setOk(null);
    let patch: Record<string, unknown>;
    try {
      patch = buildPatch(initial, form, revertSecret, t);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("settings.validateFail"));
      return;
    }
    if (Object.keys(patch).length === 0) {
      setOk(t("settings.noChange"));
      return;
    }
    setSaving(true);
    try {
      const data = await apiJson<SettingsResponse>("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      const normalizedForm = respToForm(data);
      setForm(normalizedForm);
      setInitial(normalizedForm);
      setEnvDefaults(data.env_defaults);
      const sources: Record<string, string> = {};
      for (const [key, value] of Object.entries(data.fields)) {
        if (value?.source) sources[key] = value.source;
      }
      setFieldSource(sources);
      setRevertSecret({});
      setOk(t("settings.saved"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("settings.saveFail"));
    } finally {
      setSaving(false);
    }
  }

  function row(
    key: keyof FormState,
    label: string,
    hint?: string,
    opts?: { type?: string; secret?: boolean; envHintKey?: keyof FormState },
  ) {
    const source = fieldSource[key as string] ?? "env";
    const envKey = (opts?.envHintKey ?? key) as string;
    const envValue = envDefaults[envKey];
    const envLine =
      envValue === undefined || envValue === ""
        ? null
        : typeof envValue === "boolean"
          ? t("settings.envLine", { value: envValue ? t("settings.wikiOn") : t("settings.wikiOff") })
          : t("settings.envLine", { value: String(envValue) });
    const isSecret = opts?.secret;

    return (
      <div key={key as string} className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={key as string} className="mb-0">
            {label}
          </Label>
          <SourceBadge source={source} labelOverride={t("settings.sourceOverride")} labelEnv={t("settings.sourceEnv")} />
        </div>
        {isSecret ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id={key as string}
              type={opts?.type ?? "password"}
              autoComplete="off"
              value={form[key] as string}
              onChange={(event) => {
                const value = event.target.value;
                setForm((prev) => ({ ...prev, [key]: value }));
                if (revertSecret[key as string]) {
                  setRevertSecret((current) => {
                    const next = { ...current };
                    delete next[key as string];
                    return next;
                  });
                }
              }}
              placeholder={
                fieldSource[key as string] === "override" || (envDefaults[key as string] as string) === "***"
                  ? t("settings.secretPlaceholder")
                  : t("settings.secretPlaceholderEmpty")
              }
              className="sm:max-w-md"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => {
                setRevertSecret((current) => ({ ...current, [key as string]: true }));
                setForm((prev) => ({ ...prev, [key]: "" }));
              }}
            >
              {t("settings.useEnv")}
            </Button>
          </div>
        ) : (
          <Input
            id={key as string}
            type={opts?.type ?? "text"}
            value={form[key] as string}
            onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))}
            className="max-w-xl"
          />
        )}
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        {envLine ? <p className="text-xs text-muted-foreground">{envLine}</p> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <SettingsIcon className="size-7 text-muted-foreground" aria-hidden />
          {t("settings.title")}
        </h1>
        <p className="text-sm text-muted-foreground sm:text-base">{t("settings.subtitle")}</p>
      </header>

      {loading ? (
        <p className="text-muted-foreground">{t("settings.loading")}</p>
      ) : (
        <>
          <div className="flex flex-col gap-8 pb-24 lg:flex-row lg:items-start lg:gap-10">
            <SettingsSideNav
              ariaLabel={t("settings.navAria")}
              sections={SETTINGS_SECTIONS.map((section) => ({ id: section.id, label: t(section.labelKey) }))}
              activeSection={activeSection}
              onSelectSection={scrollToSection}
            />

            <form id="settings-form" onSubmit={onSave} className="min-w-0 flex-1 space-y-8">
              {error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>
              ) : null}
              {ok ? <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground">{ok}</div> : null}

              <section id="settings-gitlab" className="scroll-mt-24 space-y-0">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">{t("settings.gitlabTitle")}</CardTitle>
                    <CardDescription>{t("settings.gitlabDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5 p-4 pt-6 sm:p-6">
                    {row("gitlab_access_token", t("settings.gitTokenLabel"), t("settings.gitTokenHint"), { secret: true })}
                    {row("git_https_username", t("settings.gitHttpsUsername"), t("settings.gitHttpsUsernameHint"))}
                  </CardContent>
                </Card>
              </section>

              <section id="settings-embedding" className="scroll-mt-24 space-y-0">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">{t("settings.embedTitle")}</CardTitle>
                    <CardDescription>{t("settings.embedDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5 p-4 pt-6 sm:p-6">{row("embed_model", "embed_model")}</CardContent>
                </Card>
              </section>

              <section id="settings-llm" className="scroll-mt-24 space-y-0">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">{t("settings.llmTitle")}</CardTitle>
                    <CardDescription>{t("settings.llmDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6 p-4 pt-6 sm:p-6">
                    <div className="space-y-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("settings.groupDify")}</p>
                      <div className="space-y-5">
                        {row("dify_base_url", "dify_base_url")}
                        {row("dify_api_key", "dify_api_key", undefined, { secret: true })}
                      </div>
                    </div>
                    <div className="space-y-4 border-t border-border/60 pt-6">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("settings.groupAzure")}</p>
                      <div className="space-y-5">
                        {row("azure_openai_endpoint", "azure_openai_endpoint")}
                        {row("azure_openai_api_key", "azure_openai_api_key", undefined, { secret: true })}
                        {row("azure_openai_version", "azure_openai_version")}
                        {row("azure_openai_deployment", "azure_openai_deployment")}
                      </div>
                    </div>
                    <div className="space-y-4 border-t border-border/60 pt-6">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("settings.groupOpenai")}</p>
                      <div className="space-y-5">
                        {row("openai_base_url", "openai_base_url")}
                        {row("openai_api_key", "openai_api_key", undefined, { secret: true })}
                        {row("openai_model", "openai_model")}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </section>

              <section id="settings-output" className="scroll-mt-24 space-y-6">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">{t("settings.contentLangTitle")}</CardTitle>
                    <CardDescription>{t("settings.contentLangDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5 p-4 pt-6 sm:p-6">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor="content_language">content_language</Label>
                        <SourceBadge
                          source={fieldSource.content_language ?? "env"}
                          labelOverride={t("settings.sourceOverride")}
                          labelEnv={t("settings.sourceEnv")}
                        />
                      </div>
                      <select
                        id="content_language"
                        className="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={form.content_language === "en" ? "en" : "zh"}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, content_language: event.target.value === "en" ? "en" : "zh" }))
                        }
                      >
                        <option value="zh">{t("settings.contentLang.zh")}</option>
                        <option value="en">{t("settings.contentLang.en")}</option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.envLine", {
                          value: String(envDefaults.content_language ?? "zh").toLowerCase().startsWith("en") ? "en" : "zh",
                        })}
                      </p>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">{t("settings.wikiTitle")}</CardTitle>
                    <CardDescription>{t("settings.wikiDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5 p-4 pt-6 sm:p-6">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor="wiki_enabled">{t("settings.wikiEnabled")}</Label>
                        <SourceBadge
                          source={fieldSource.wiki_enabled ?? "env"}
                          labelOverride={t("settings.sourceOverride")}
                          labelEnv={t("settings.sourceEnv")}
                        />
                      </div>
                      <input
                        id="wiki_enabled"
                        type="checkbox"
                        className="size-4 rounded border-input accent-primary"
                        checked={form.wiki_enabled}
                        onChange={(event) => setForm((prev) => ({ ...prev, wiki_enabled: event.target.checked }))}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("settings.envLine", {
                          value: envDefaults.wiki_enabled ? t("settings.wikiOn") : t("settings.wikiOff"),
                        })}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor="wiki_backend">{t("settings.wikiBackend")}</Label>
                        <SourceBadge
                          source={fieldSource.wiki_backend ?? "env"}
                          labelOverride={t("settings.sourceOverride")}
                          labelEnv={t("settings.sourceEnv")}
                        />
                      </div>
                      <select
                        id="wiki_backend"
                        className="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={form.wiki_backend}
                        onChange={(event) => setForm((prev) => ({ ...prev, wiki_backend: event.target.value }))}
                      >
                        <option value="mkdocs">mkdocs</option>
                        <option value="starlight">starlight</option>
                        <option value="vitepress">vitepress</option>
                      </select>
                      <p className="text-xs text-muted-foreground">{t("settings.envLine", { value: String(envDefaults.wiki_backend ?? "") })}</p>
                    </div>
                    {row("wiki_max_file_pages", "wiki_max_file_pages", t("settings.wikiPages"))}
                    {row("wiki_symbol_rows_per_file", "wiki_symbol_rows_per_file", t("settings.wikiRows"))}
                    {row("npm_registry", "npm_registry", t("settings.npmPh"))}
                  </CardContent>
                </Card>
              </section>
            </form>
          </div>

          <SettingsActionsBar
            ariaLabel={t("settings.actionsBarAria")}
            saving={saving}
            reloadLabel={t("settings.reload")}
            saveLabel={t("settings.save")}
            savingLabel={t("settings.saving")}
            onReload={() => void load()}
          />
        </>
      )}
    </div>
  );
}
