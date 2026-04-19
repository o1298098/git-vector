import { useCallback, useEffect, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/I18nContext";
import { SettingsActionsBar } from "./components/SettingsActionsBar";
import { SettingsSideNav } from "./components/SettingsSideNav";
import { SourceBadge } from "./components/SourceBadge";
import {
  EMPTY_FORM,
  SETTINGS_SECTIONS,
  type AdminStorageResponse,
  type FormState,
  type SettingsResponse,
} from "./types";
import { buildPatch, respToForm } from "./utils";

function formatBytes(n: number): string {
  const x = Number(n) || 0;
  if (x <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = x;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const decimals = i === 0 ? 0 : v < 10 ? 2 : 1;
  return `${v.toFixed(decimals)} ${units[i]}`;
}

function sharePercent(sizeBytes: number, totalBytes: number): number {
  const s = Number(sizeBytes) || 0;
  const t = Number(totalBytes) || 0;
  if (t <= 0 || s <= 0) return 0;
  return Math.min(100, Math.round((s / t) * 1000) / 10);
}

const STORAGE_LABEL_KEYS: Record<string, string> = {
  repos: "settings.storageCat.repos",
  chroma: "settings.storageCat.chroma",
  wiki_sites: "settings.storageCat.wiki_sites",
  wiki_work: "settings.storageCat.wiki_work",
  index_jobs: "settings.storageCat.index_jobs",
  project_index: "settings.storageCat.project_index",
  llm_usage: "settings.storageCat.llm_usage",
  ui_overrides: "settings.storageCat.ui_overrides",
};

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
  const [storage, setStorage] = useState<AdminStorageResponse | null>(null);
  const [storageErr, setStorageErr] = useState<string | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);

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

  const loadStorage = useCallback(async () => {
    setStorageErr(null);
    setStorageLoading(true);
    try {
      const data = await apiJson<AdminStorageResponse>("/api/admin/storage");
      setStorage(data);
    } catch (err: unknown) {
      setStorage(null);
      setStorageErr(err instanceof Error ? err.message : t("settings.storageLoadFail"));
    } finally {
      setStorageLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadStorage();
  }, [loadStorage]);

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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <SettingsIcon className="size-7 text-muted-foreground" aria-hidden />
            {t("settings.title")}
          </h1>
          <Button asChild type="button" variant="outline" size="sm">
            <Link to="/audit">{t("settings.auditEntry")}</Link>
          </Button>
        </div>
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

            <div className="min-w-0 flex-1 space-y-8">
            <form id="settings-form" onSubmit={onSave} className="space-y-8">
              {error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>
              ) : null}
              {ok ? <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground">{ok}</div> : null}

              <section id="settings-gitlab" className="scroll-mt-24 space-y-0">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">HTTPS 凭据</CardTitle>
                    <CardDescription>按 GitLab / GitHub / Gitee 分开配置，便于后续 webhook 与项目创建时识别仓库类型。</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-8 p-4 pt-6 sm:p-6">
                    <div className="space-y-5">
                      <div className="space-y-1">
                        <h3 className="text-base font-semibold">GitLab</h3>
                        <p className="text-sm text-muted-foreground">GitLab 私有仓库建议填写 PAT；HTTPS 用户名默认回退为 oauth2。</p>
                      </div>
                      {row("gitlab_access_token", "GitLab PAT", "对应环境变量 GITLAB_ACCESS_TOKEN。", { secret: true })}
                      {row("gitlab_https_username", "GitLab HTTPS 用户名（可选）", "默认 oauth2；如有特殊账号格式可覆盖。")}
                    </div>
                    <div className="space-y-5 border-t border-border/60 pt-6">
                      <div className="space-y-1">
                        <h3 className="text-base font-semibold">GitHub</h3>
                        <p className="text-sm text-muted-foreground">GitHub 私有仓库建议填写 PAT；HTTPS 用户名默认回退为 x-access-token。</p>
                      </div>
                      {row("github_access_token", "GitHub PAT", "用于 GitHub HTTPS 克隆鉴权。", { secret: true })}
                      {row("github_https_username", "GitHub HTTPS 用户名（可选）", "默认 x-access-token，也可填写你的 GitHub 用户名。")}
                    </div>
                    <div className="space-y-5 border-t border-border/60 pt-6">
                      <div className="space-y-1">
                        <h3 className="text-base font-semibold">Gitee</h3>
                        <p className="text-sm text-muted-foreground">Gitee 私有仓库建议填写 PAT；HTTPS 用户名可按 Gitee 账户习惯覆盖。</p>
                      </div>
                      {row("gitee_access_token", "Gitee PAT", "用于 Gitee HTTPS 克隆鉴权。", { secret: true })}
                      {row("gitee_https_username", "Gitee HTTPS 用户名（可选）", "默认 oauth2；如你的 Gitee 需要指定用户名可在这里配置。")}
                    </div>
                    <div className="space-y-5 border-t border-border/60 pt-6">
                      <div className="space-y-1">
                        <h3 className="text-base font-semibold">通用兜底</h3>
                        <p className="text-sm text-muted-foreground">当仓库类型无法识别或你希望统一使用同一套 HTTPS 用户名时，会回退到这里。</p>
                      </div>
                      {row("git_https_username", "通用 HTTPS 用户名（可选）", "未命中平台专属用户名时使用；GitLab/Gitee 默认 oauth2，GitHub 默认 x-access-token。")}
                    </div>
                  </CardContent>
                </Card>
              </section>

              <section id="settings-embedding" className="scroll-mt-24 space-y-0">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">{t("settings.embedTitle")}</CardTitle>
                    <CardDescription>{t("settings.embedDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5 p-4 pt-6 sm:p-6">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor="embed_provider">{t("settings.embedProviderLabel")}</Label>
                        <SourceBadge
                          source={fieldSource.embed_provider ?? "env"}
                          labelOverride={t("settings.sourceOverride")}
                          labelEnv={t("settings.sourceEnv")}
                        />
                      </div>
                      <select
                        id="embed_provider"
                        className="flex h-9 w-full max-w-xl rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={form.embed_provider === "openai" ? "openai" : "ollama"}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, embed_provider: event.target.value === "openai" ? "openai" : "ollama" }))
                        }
                      >
                        <option value="ollama">{t("settings.embedProvider.ollama")}</option>
                        <option value="openai">{t("settings.embedProvider.openai")}</option>
                      </select>
                      <p className="text-xs text-muted-foreground">{t("settings.embedProviderHint")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.envLine", { value: String(envDefaults.embed_provider ?? "ollama") })}
                      </p>
                    </div>
                    {row("embed_model", "embed_model", t("settings.embedModelHint"))}
                    {form.embed_provider === "ollama" ? (
                      <>
                        {row("ollama_base_url", "ollama_base_url")}
                        {row("ollama_api_key", "ollama_api_key", undefined, { secret: true })}
                      </>
                    ) : (
                      <>
                        {row("openai_embed_base_url", t("settings.openaiEmbedBaseUrl"), t("settings.openaiEmbedBaseUrlHint"))}
                        {row("openai_embed_api_key", t("settings.openaiEmbedApiKey"), undefined, { secret: true })}
                      </>
                    )}
                  </CardContent>
                </Card>
              </section>

              <section id="settings-indexing" className="scroll-mt-24 space-y-0">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">{t("settings.indexExcludeTitle")}</CardTitle>
                    <CardDescription>{t("settings.indexExcludeDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 p-4 pt-6 sm:p-6">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor="index_exclude_patterns">{t("settings.indexExcludeLabel")}</Label>
                        <SourceBadge
                          source={fieldSource.index_exclude_patterns ?? "env"}
                          labelOverride={t("settings.sourceOverride")}
                          labelEnv={t("settings.sourceEnv")}
                        />
                      </div>
                      <Textarea
                        id="index_exclude_patterns"
                        className="min-h-[140px] max-w-3xl font-mono text-xs"
                        spellCheck={false}
                        value={form.index_exclude_patterns}
                        onChange={(event) => setForm((prev) => ({ ...prev, index_exclude_patterns: event.target.value }))}
                        placeholder={"**/*.pb.go\ngenerated/**/*"}
                      />
                      <p className="text-xs text-muted-foreground">{t("settings.indexExcludeHint")}</p>
                      {envDefaults.index_exclude_patterns != null &&
                      String(envDefaults.index_exclude_patterns).trim() !== "" ? (
                        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                          {t("settings.envLine", { value: String(envDefaults.index_exclude_patterns) })}
                        </p>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              </section>

              <section id="settings-audit" className="scroll-mt-24 space-y-0">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">{t("settings.auditRetentionTitle")}</CardTitle>
                    <CardDescription>{t("settings.auditRetentionDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5 p-4 pt-6 sm:p-6">
                    {row("audit_retention_days", t("settings.auditRetentionLabel"), t("settings.auditRetentionHint"), { type: "number" })}
                  </CardContent>
                </Card>
              </section>

              <section id="settings-llm" className="scroll-mt-24 space-y-0">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <CardTitle className="text-lg">{t("settings.llmTitle")}</CardTitle>
                    <CardDescription>{t("settings.llmDesc")}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6 p-4 pt-6 sm:p-6">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor="llm_provider">{t("settings.llmProviderLabel")}</Label>
                        <SourceBadge
                          source={fieldSource.llm_provider ?? "env"}
                          labelOverride={t("settings.sourceOverride")}
                          labelEnv={t("settings.sourceEnv")}
                        />
                      </div>
                      <select
                        id="llm_provider"
                        className="flex h-9 w-full max-w-xl rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={
                          form.llm_provider === "dify" || form.llm_provider === "azure_openai" || form.llm_provider === "openai"
                            ? form.llm_provider
                            : "openai"
                        }
                        onChange={(event) => setForm((prev) => ({ ...prev, llm_provider: event.target.value }))}
                      >
                        <option value="dify">{t("settings.llmProvider.dify")}</option>
                        <option value="azure_openai">{t("settings.llmProvider.azure")}</option>
                        <option value="openai">{t("settings.llmProvider.openai")}</option>
                      </select>
                      <p className="text-xs text-muted-foreground">{t("settings.llmProviderExplicitHint")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.envLine", { value: String(envDefaults.llm_provider ?? "openai") })}
                      </p>
                    </div>

                    {form.llm_provider === "dify" ? (
                    <div className="space-y-4 border-t border-border/60 pt-6">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("settings.groupDify")}</p>
                      <div className="space-y-5">
                        {row("dify_base_url", "dify_base_url")}
                        {row("dify_api_key", "dify_api_key", undefined, { secret: true })}
                      </div>
                    </div>
                    ) : null}
                    {form.llm_provider === "azure_openai" ? (
                    <div className="space-y-4 border-t border-border/60 pt-6">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("settings.groupAzure")}</p>
                      <div className="space-y-5">
                        {row("azure_openai_endpoint", "azure_openai_endpoint")}
                        {row("azure_openai_api_key", "azure_openai_api_key", undefined, { secret: true })}
                        {row("azure_openai_version", "azure_openai_version")}
                        {row("azure_openai_deployment", "azure_openai_deployment")}
                      </div>
                    </div>
                    ) : null}
                    {form.llm_provider === "openai" ? (
                    <div className="space-y-4 border-t border-border/60 pt-6">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("settings.groupOpenai")}</p>
                      <div className="space-y-5">
                        {row("openai_base_url", "openai_base_url")}
                        {row("openai_api_key", "openai_api_key", undefined, { secret: true })}
                        {row("openai_model", "openai_model")}
                      </div>
                    </div>
                    ) : null}
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

              <section id="settings-storage" className="scroll-mt-24 space-y-0">
                <Card className="border shadow-sm">
                  <CardHeader className="border-b bg-muted/30 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <CardTitle className="text-lg">{t("settings.storageTitle")}</CardTitle>
                      </div>
                      <Button type="button" variant="outline" size="sm" disabled={storageLoading} onClick={() => void loadStorage()}>
                        {t("settings.storageRefresh")}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-5 p-4 pt-6 sm:p-6">
                    {storageErr ? (
                      <p className="text-sm text-destructive">{storageErr}</p>
                    ) : null}
                    {storageLoading && !storage ? (
                      <p className="text-sm text-muted-foreground">{t("settings.loading")}</p>
                    ) : null}
                    {storage ? (
                      <div className="space-y-5">
                        <div className="space-y-3 rounded-md border border-border/70 bg-background/80 p-3">
                          <p className="text-sm font-medium text-foreground">{t("settings.storageVolumeTitle")}</p>
                          <p className="text-xs text-muted-foreground">
                            {t("settings.storageVolumeUsed", {
                              used: formatBytes(storage.volume.used_bytes),
                              total: formatBytes(storage.volume.total_bytes),
                              free: formatBytes(storage.volume.free_bytes),
                            })}
                          </p>
                          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary/80"
                              style={{
                                width: `${Math.min(100, Math.round((storage.volume.used_bytes / Math.max(1, storage.volume.total_bytes)) * 1000) / 10)}%`,
                              }}
                            />
                          </div>
                          <div className="border-t border-border/60 pt-3">
                            <p className="mb-2 text-sm font-medium">{t("settings.storageFocusTitle")}</p>
                          {(() => {
                            const items = [
                              {
                                key: "vector",
                                label: t("settings.storageFocus.vector"),
                                size: storage.summary?.vector_store_bytes ?? 0,
                                tone: "bg-emerald-500/80 dark:bg-emerald-400/70",
                              },
                              {
                                key: "repo",
                                label: t("settings.storageFocus.repo"),
                                size: storage.summary?.repo_mirrors_bytes ?? 0,
                                tone: "bg-blue-500/80 dark:bg-blue-400/70",
                              },
                              {
                                key: "wiki",
                                label: t("settings.storageFocus.wiki"),
                                size: storage.summary?.wiki_sites_bytes ?? 0,
                                tone: "bg-violet-500/80 dark:bg-violet-400/70",
                              },
                            ];
                            const total = items.reduce((sum, it) => sum + Math.max(0, Number(it.size) || 0), 0);
                            return (
                              <div className="space-y-3">
                                <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                                  {items.map((item, idx) => {
                                    const width = total > 0 ? (Math.max(0, Number(item.size) || 0) / total) * 100 : 0;
                                    const radiusClass =
                                      idx === 0
                                        ? "rounded-l-full"
                                        : idx === items.length - 1
                                          ? "rounded-r-full"
                                          : "";
                                    return (
                                      <div
                                        key={item.key}
                                        className={`inline-block h-full ${radiusClass} ${item.tone} align-top`}
                                        style={{ width: `${Math.max(0, Math.min(100, width))}%` }}
                                        title={`${item.label}: ${formatBytes(item.size)}`}
                                      />
                                    );
                                  })}
                                </div>
                                <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                                  {items.map((item) => {
                                    const pct = total > 0 ? Math.round(((Math.max(0, Number(item.size) || 0) / total) * 1000)) / 10 : 0;
                                    return (
                                      <div key={item.key} className="flex items-center gap-2 text-xs">
                                        <span className={`inline-block h-2.5 w-2.5 rounded-full ${item.tone}`} />
                                        <span className="text-foreground">{item.label}</span>
                                        <span className="tabular-nums text-muted-foreground">{t("settings.storagePct", { pct: String(pct) })}</span>
                                        <span className="ml-auto tabular-nums text-muted-foreground">{formatBytes(item.size)}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })()}
                          </div>
                        </div>
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <p className="text-sm font-medium">{t("settings.storageBreakdownTitle")}</p>
                          </div>
                          <details className="rounded-md border border-border/80 bg-muted/10 p-3 sm:p-4">
                            <summary className="cursor-pointer text-sm font-medium text-foreground">
                              {t("settings.storageDetailsToggle")}
                            </summary>
                            <p className="mt-1 text-xs text-muted-foreground">{t("settings.storageDetailsDesc")}</p>
                            <div className="mt-4 space-y-4">
                              {storage.breakdown.map((row) => {
                                const pct = sharePercent(row.size_bytes, storage.data_dir_total_bytes);
                                const label = t(STORAGE_LABEL_KEYS[row.key] ?? `settings.storageCat.${row.key}`);
                                return (
                                  <div key={row.key} className="space-y-1.5">
                                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                      <div className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground">
                                        <span>{label}</span>
                                        {!row.exists ? (
                                          <span className="ml-2 text-xs font-normal text-muted-foreground">({t("settings.storageNo")})</span>
                                        ) : null}
                                      </div>
                                      <div className="shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                                        <span className="text-foreground">{formatBytes(row.size_bytes)}</span>
                                        <span className="ml-2 text-xs">{t("settings.storagePct", { pct: String(pct) })}</span>
                                      </div>
                                    </div>
                                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" title={row.path}>
                                      <div
                                        className="h-full rounded-full bg-primary/75 transition-[width] duration-300"
                                        style={{ width: `${pct}%` }}
                                      />
                                    </div>
                                    <p className="truncate font-mono text-[11px] text-muted-foreground" title={row.path}>
                                      {row.path}
                                    </p>
                                  </div>
                                );
                              })}
                              {(() => {
                                const pct = sharePercent(storage.other_bytes, storage.data_dir_total_bytes);
                                return (
                                  <div className="space-y-1.5 border-t border-border/60 pt-4">
                                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                      <div className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground">
                                        {t("settings.storageOther")}
                                      </div>
                                      <div className="shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                                        <span className="text-foreground">{formatBytes(storage.other_bytes)}</span>
                                        <span className="ml-2 text-xs">{t("settings.storagePct", { pct: String(pct) })}</span>
                                      </div>
                                    </div>
                                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" title={storage.data_dir}>
                                      <div className="h-full rounded-full bg-orange-500/55 dark:bg-orange-400/45" style={{ width: `${pct}%` }} />
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          </details>
                          <p className="text-xs text-muted-foreground">
                            {t("settings.storageDataTotal")}:{" "}
                            <span className="font-medium text-foreground">{formatBytes(storage.data_dir_total_bytes)}</span>
                            {" · "}
                            {t("settings.storageRepoPolicy", {
                              dirs: String(storage.repo_cache.cached_repo_dirs),
                              maxGb: storage.repo_cache.max_gb > 0 ? String(storage.repo_cache.max_gb) : "0",
                              maxCount: storage.repo_cache.max_count > 0 ? String(storage.repo_cache.max_count) : "0",
                            })}
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </section>
            </div>
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
