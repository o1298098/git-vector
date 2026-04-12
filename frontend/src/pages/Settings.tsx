import { useCallback, useEffect, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nContext";

type FieldMeta = { value: string | number | boolean; source: string };
type SettingsResponse = { fields: Record<string, FieldMeta>; env_defaults: Record<string, string | number | boolean> };

const SECRET_KEYS = ["openai_api_key", "dify_api_key", "azure_openai_api_key", "gitlab_access_token"] as const;

const SETTINGS_SECTIONS: { id: string; labelKey: string }[] = [
  { id: "settings-gitlab", labelKey: "settings.navGitlab" },
  { id: "settings-embedding", labelKey: "settings.navEmbedding" },
  { id: "settings-llm", labelKey: "settings.navLlm" },
  { id: "settings-output", labelKey: "settings.navOutput" },
];

type FormState = {
  embed_model: string;
  openai_model: string;
  openai_base_url: string;
  openai_api_key: string;
  dify_base_url: string;
  dify_api_key: string;
  azure_openai_api_key: string;
  azure_openai_endpoint: string;
  azure_openai_version: string;
  azure_openai_deployment: string;
  gitlab_access_token: string;
  wiki_enabled: boolean;
  wiki_backend: string;
  wiki_max_file_pages: string;
  wiki_symbol_rows_per_file: string;
  npm_registry: string;
  content_language: string;
};

const EMPTY_FORM: FormState = {
  embed_model: "",
  openai_model: "",
  openai_base_url: "",
  openai_api_key: "",
  dify_base_url: "",
  dify_api_key: "",
  azure_openai_api_key: "",
  azure_openai_endpoint: "",
  azure_openai_version: "",
  azure_openai_deployment: "",
  gitlab_access_token: "",
  wiki_enabled: true,
  wiki_backend: "mkdocs",
  wiki_max_file_pages: "5000",
  wiki_symbol_rows_per_file: "4000",
  npm_registry: "",
  content_language: "zh",
};

function respToForm(resp: SettingsResponse): FormState {
  const { fields } = resp;
  const str = (k: keyof FormState) => {
    const v = fields[k]?.value;
    if (v === undefined || v === null) return "";
    return String(v);
  };
  const wikiOn = fields.wiki_enabled?.value;
  const wikiBool =
    wikiOn === undefined || wikiOn === null
      ? true
      : typeof wikiOn === "boolean"
        ? wikiOn
        : typeof wikiOn === "string"
          ? wikiOn.toLowerCase() === "true" || wikiOn === "1"
          : false;
  return {
    embed_model: str("embed_model"),
    openai_model: str("openai_model"),
    openai_base_url: str("openai_base_url"),
    openai_api_key: fields.openai_api_key?.value === "***" ? "" : str("openai_api_key"),
    dify_base_url: str("dify_base_url"),
    dify_api_key: fields.dify_api_key?.value === "***" ? "" : str("dify_api_key"),
    azure_openai_api_key: fields.azure_openai_api_key?.value === "***" ? "" : str("azure_openai_api_key"),
    azure_openai_endpoint: str("azure_openai_endpoint"),
    azure_openai_version: str("azure_openai_version"),
    azure_openai_deployment: str("azure_openai_deployment"),
    gitlab_access_token: fields.gitlab_access_token?.value === "***" ? "" : str("gitlab_access_token"),
    wiki_enabled: wikiBool,
    wiki_backend: str("wiki_backend") || "mkdocs",
    wiki_max_file_pages: str("wiki_max_file_pages") || "5000",
    wiki_symbol_rows_per_file: str("wiki_symbol_rows_per_file") || "4000",
    npm_registry: str("npm_registry"),
    content_language: (() => {
      const v = str("content_language").toLowerCase();
      return v === "en" ? "en" : "zh";
    })(),
  };
}

function buildPatch(
  a: FormState,
  b: FormState,
  revertSecret: Record<string, boolean>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const keys: (keyof FormState)[] = [
    "embed_model",
    "openai_model",
    "openai_base_url",
    "dify_base_url",
    "azure_openai_endpoint",
    "azure_openai_version",
    "azure_openai_deployment",
    "wiki_backend",
    "npm_registry",
  ];
  for (const k of keys) {
    if (a[k] !== b[k]) p[k] = b[k];
  }
  if (a.wiki_enabled !== b.wiki_enabled) p.wiki_enabled = b.wiki_enabled;
  if (a.wiki_max_file_pages !== b.wiki_max_file_pages) {
    const n = parseInt(b.wiki_max_file_pages, 10);
    if (!Number.isFinite(n)) throw new Error(t("settings.errWikiPages"));
    p.wiki_max_file_pages = n;
  }
  if (a.wiki_symbol_rows_per_file !== b.wiki_symbol_rows_per_file) {
    const n = parseInt(b.wiki_symbol_rows_per_file, 10);
    if (!Number.isFinite(n)) throw new Error(t("settings.errWikiRows"));
    p.wiki_symbol_rows_per_file = n;
  }
  for (const sk of SECRET_KEYS) {
    if (revertSecret[sk]) {
      p[sk] = null;
      continue;
    }
    const secretVal = b[sk].trim();
    if (secretVal !== "") p[sk] = secretVal;
  }
  if (a.content_language !== b.content_language) {
    p.content_language = b.content_language === "en" ? "en" : "zh";
  }
  return p;
}

function SourceBadge({ source, labelOverride, labelEnv }: { source: string; labelOverride: string; labelEnv: string }) {
  const override = source === "override";
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        override ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {override ? labelOverride : labelEnv}
    </span>
  );
}

export function Settings() {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [initial, setInitial] = useState<FormState>(EMPTY_FORM);
  const [envDefaults, setEnvDefaults] = useState<SettingsResponse["env_defaults"]>({});
  const [fieldSource, setFieldSource] = useState<Record<string, string>>({});
  const [revertSecret, setRevertSecret] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string>(SETTINGS_SECTIONS[0]?.id ?? "settings-gitlab");

  const load = useCallback(async () => {
    setErr(null);
    setOk(null);
    setLoading(true);
    try {
      const data = await apiJson<SettingsResponse>("/api/admin/settings");
      const f = respToForm(data);
      setForm(f);
      setInitial(f);
      setEnvDefaults(data.env_defaults);
      const src: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.fields)) {
        if (v?.source) src[k] = v.source;
      }
      setFieldSource(src);
      setRevertSecret({});
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("settings.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loading) return;
    const sectionEls = SETTINGS_SECTIONS.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => Boolean(el));
    if (sectionEls.length === 0) return;

    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          const id = visible[0].target.id;
          if (id) setActiveSection(id);
        }
      },
      { root: null, rootMargin: "-10% 0px -52% 0px", threshold: [0, 0.05, 0.15] },
    );
    sectionEls.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [loading]);

  function scrollToSection(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(null);
    let patch: Record<string, unknown>;
    try {
      patch = buildPatch(initial, form, revertSecret, t);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("settings.validateFail"));
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
      const f = respToForm(data);
      setForm(f);
      setInitial(f);
      setEnvDefaults(data.env_defaults);
      const src: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.fields)) {
        if (v?.source) src[k] = v.source;
      }
      setFieldSource(src);
      setRevertSecret({});
      setOk(t("settings.saved"));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("settings.saveFail"));
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
    const src = fieldSource[key as string] ?? "env";
    const envKey = (opts?.envHintKey ?? key) as string;
    const envVal = envDefaults[envKey];
    const envLine =
      envVal === undefined || envVal === ""
        ? null
        : typeof envVal === "boolean"
          ? t("settings.envLine", { value: envVal ? t("settings.wikiOn") : t("settings.wikiOff") })
          : t("settings.envLine", { value: String(envVal) });
    const isSecret = opts?.secret;

    return (
      <div key={key as string} className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={key as string} className="mb-0">
            {label}
          </Label>
          <SourceBadge source={src} labelOverride={t("settings.sourceOverride")} labelEnv={t("settings.sourceEnv")} />
        </div>
        {isSecret ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id={key as string}
              type={opts?.type ?? "password"}
              autoComplete="off"
              value={form[key] as string}
              onChange={(e) => {
                const v = e.target.value;
                setForm((prev) => ({ ...prev, [key]: v }));
                if (revertSecret[key as string]) {
                  setRevertSecret((r) => {
                    const n = { ...r };
                    delete n[key as string];
                    return n;
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
                setRevertSecret((r) => ({ ...r, [key as string]: true }));
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
            onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
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
            <aside className="shrink-0 lg:sticky lg:top-20 lg:z-10 lg:w-56 lg:self-start">
              <div className="rounded-xl border border-border/80 bg-card p-2 shadow-md ring-1 ring-black/5 dark:ring-white/10">
                <nav className="flex flex-col gap-0.5" aria-label={t("settings.navAria")}>
                  {SETTINGS_SECTIONS.map(({ id, labelKey }) => {
                    const active = activeSection === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => scrollToSection(id)}
                        className={cn(
                          "w-full rounded-lg px-3 py-2.5 text-left text-sm leading-snug transition-colors",
                          active
                            ? "bg-primary/10 font-medium text-primary"
                            : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                        )}
                      >
                        {t(labelKey)}
                      </button>
                    );
                  })}
                </nav>
              </div>
            </aside>

            <form id="settings-form" onSubmit={onSave} className="min-w-0 flex-1 space-y-8">
              {err ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</div>
              ) : null}
              {ok ? (
                <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground">{ok}</div>
              ) : null}

              <section id="settings-gitlab" className="scroll-mt-24 space-y-0">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">{t("settings.gitlabTitle")}</CardTitle>
                    <CardDescription>{t("settings.gitlabDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5 p-4 pt-6 sm:p-6">
                    {row("gitlab_access_token", "gitlab_access_token", undefined, { secret: true })}
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
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, content_language: e.target.value === "en" ? "en" : "zh" }))
                        }
                      >
                        <option value="zh">{t("settings.contentLang.zh")}</option>
                        <option value="en">{t("settings.contentLang.en")}</option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.envLine", {
                          value:
                            String(envDefaults.content_language ?? "zh").toLowerCase().startsWith("en") ? "en" : "zh",
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
                        onChange={(e) => setForm((prev) => ({ ...prev, wiki_enabled: e.target.checked }))}
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
                        onChange={(e) => setForm((prev) => ({ ...prev, wiki_backend: e.target.value }))}
                      >
                        <option value="mkdocs">mkdocs</option>
                        <option value="starlight">starlight</option>
                        <option value="vitepress">vitepress</option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.envLine", { value: String(envDefaults.wiki_backend ?? "") })}
                      </p>
                    </div>
                    {row("wiki_max_file_pages", "wiki_max_file_pages", t("settings.wikiPages"))}
                    {row("wiki_symbol_rows_per_file", "wiki_symbol_rows_per_file", t("settings.wikiRows"))}
                    {row("npm_registry", "npm_registry", t("settings.npmPh"))}
                  </CardContent>
                </Card>
              </section>
          </form>
        </div>

        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.1)] backdrop-blur supports-[backdrop-filter]:bg-background/85 dark:shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.35)]"
          role="region"
          aria-label={t("settings.actionsBarAria")}
        >
          <div className="mx-auto max-w-[1600px] px-4 sm:px-6">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-end gap-3">
              <Button type="button" variant="outline" disabled={saving} onClick={() => void load()}>
                {t("settings.reload")}
              </Button>
              <Button type="submit" form="settings-form" disabled={saving}>
                {saving ? t("settings.saving") : t("settings.save")}
              </Button>
            </div>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
