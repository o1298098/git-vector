export type FieldMeta = { value: string | number | boolean; source: string };

export type SettingsResponse = {
  fields: Record<string, FieldMeta>;
  env_defaults: Record<string, string | number | boolean>;
};

export const SECRET_KEYS = [
  "ollama_api_key",
  "openai_api_key",
  "openai_embed_api_key",
  "dify_api_key",
  "azure_openai_api_key",
  "gitlab_access_token",
] as const;

export const SETTINGS_SECTIONS: { id: string; labelKey: string }[] = [
  { id: "settings-gitlab", labelKey: "settings.navGitlab" },
  { id: "settings-embedding", labelKey: "settings.navEmbedding" },
  { id: "settings-indexing", labelKey: "settings.navIndexing" },
  { id: "settings-audit", labelKey: "settings.navAudit" },
  { id: "settings-llm", labelKey: "settings.navLlm" },
  { id: "settings-output", labelKey: "settings.navOutput" },
  { id: "settings-storage", labelKey: "settings.navStorage" },
];

export type AdminStorageResponse = {
  data_dir: string;
  volume: { total_bytes: number; free_bytes: number; used_bytes: number };
  breakdown: Array<{ key: string; path: string; size_bytes: number; exists: boolean }>;
  other_bytes: number;
  data_dir_total_bytes: number;
  repo_cache: { max_gb: number; max_count: number; cached_repo_dirs: number };
  summary: { vector_store_bytes: number; repo_mirrors_bytes: number; wiki_sites_bytes: number };
};

export type FormState = {
  embed_model: string;
  /** ollama | openai */
  embed_provider: string;
  ollama_base_url: string;
  ollama_api_key: string;
  /** dify | azure_openai | openai */
  llm_provider: string;
  openai_model: string;
  openai_base_url: string;
  openai_api_key: string;
  openai_embed_base_url: string;
  openai_embed_api_key: string;
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
  index_exclude_patterns: string;
  audit_retention_days: string;
};

export const EMPTY_FORM: FormState = {
  embed_model: "",
  embed_provider: "ollama",
  ollama_base_url: "",
  ollama_api_key: "",
  llm_provider: "openai",
  openai_model: "",
  openai_base_url: "",
  openai_api_key: "",
  openai_embed_base_url: "",
  openai_embed_api_key: "",
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
  index_exclude_patterns: "",
  audit_retention_days: "90",
};
