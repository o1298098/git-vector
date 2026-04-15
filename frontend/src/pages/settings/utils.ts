import { type FormState, type SettingsResponse, SECRET_KEYS } from "./types";

export function respToForm(response: SettingsResponse): FormState {
  const { fields } = response;
  const str = (key: keyof FormState) => {
    const value = fields[key]?.value;
    if (value === undefined || value === null) return "";
    return String(value);
  };
  const wikiValue = fields.wiki_enabled?.value;
  const wikiEnabled =
    wikiValue === undefined || wikiValue === null
      ? true
      : typeof wikiValue === "boolean"
        ? wikiValue
        : typeof wikiValue === "string"
          ? wikiValue.toLowerCase() === "true" || wikiValue === "1"
          : false;
  return {
    embed_model: str("embed_model"),
    ollama_base_url: str("ollama_base_url"),
    ollama_api_key: fields.ollama_api_key?.value === "***" ? "" : str("ollama_api_key"),
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
    git_https_username: str("git_https_username"),
    wiki_enabled: wikiEnabled,
    wiki_backend: str("wiki_backend") || "mkdocs",
    wiki_max_file_pages: str("wiki_max_file_pages") || "5000",
    wiki_symbol_rows_per_file: str("wiki_symbol_rows_per_file") || "4000",
    npm_registry: str("npm_registry"),
    content_language: (() => {
      const value = str("content_language").toLowerCase();
      return value === "en" ? "en" : "zh";
    })(),
    index_exclude_patterns: str("index_exclude_patterns"),
  };
}

export function buildPatch(
  initial: FormState,
  form: FormState,
  revertSecret: Record<string, boolean>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const keys: (keyof FormState)[] = [
    "embed_model",
    "ollama_base_url",
    "openai_model",
    "openai_base_url",
    "dify_base_url",
    "azure_openai_endpoint",
    "azure_openai_version",
    "azure_openai_deployment",
    "wiki_backend",
    "npm_registry",
    "git_https_username",
  ];
  for (const key of keys) {
    if (initial[key] !== form[key]) patch[key] = form[key];
  }
  if (initial.wiki_enabled !== form.wiki_enabled) patch.wiki_enabled = form.wiki_enabled;
  if (initial.wiki_max_file_pages !== form.wiki_max_file_pages) {
    const pages = parseInt(form.wiki_max_file_pages, 10);
    if (!Number.isFinite(pages)) throw new Error(t("settings.errWikiPages"));
    patch.wiki_max_file_pages = pages;
  }
  if (initial.wiki_symbol_rows_per_file !== form.wiki_symbol_rows_per_file) {
    const rows = parseInt(form.wiki_symbol_rows_per_file, 10);
    if (!Number.isFinite(rows)) throw new Error(t("settings.errWikiRows"));
    patch.wiki_symbol_rows_per_file = rows;
  }
  for (const secretKey of SECRET_KEYS) {
    if (revertSecret[secretKey]) {
      patch[secretKey] = null;
      continue;
    }
    const secretValue = form[secretKey].trim();
    if (secretValue !== "") patch[secretKey] = secretValue;
  }
  if (initial.content_language !== form.content_language) {
    patch.content_language = form.content_language === "en" ? "en" : "zh";
  }
  if (initial.index_exclude_patterns !== form.index_exclude_patterns) {
    patch.index_exclude_patterns = form.index_exclude_patterns;
  }
  return patch;
}
