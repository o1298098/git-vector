export type FieldMeta = { value: string | number | boolean; source: string };

export type SettingsResponse = {
  fields: Record<string, FieldMeta>;
  env_defaults: Record<string, string | number | boolean>;
};

export const SECRET_KEYS = ["openai_api_key", "dify_api_key", "azure_openai_api_key", "gitlab_access_token"] as const;

export const SETTINGS_SECTIONS: { id: string; labelKey: string }[] = [
  { id: "settings-gitlab", labelKey: "settings.navGitlab" },
  { id: "settings-embedding", labelKey: "settings.navEmbedding" },
  { id: "settings-llm", labelKey: "settings.navLlm" },
  { id: "settings-output", labelKey: "settings.navOutput" },
];

export type FormState = {
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
  git_https_username: string;
  wiki_enabled: boolean;
  wiki_backend: string;
  wiki_max_file_pages: string;
  wiki_symbol_rows_per_file: string;
  npm_registry: string;
  content_language: string;
};

export const EMPTY_FORM: FormState = {
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
  git_https_username: "",
  wiki_enabled: true,
  wiki_backend: "mkdocs",
  wiki_max_file_pages: "5000",
  wiki_symbol_rows_per_file: "4000",
  npm_registry: "",
  content_language: "zh",
};
