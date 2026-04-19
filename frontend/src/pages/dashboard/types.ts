export type ProjectRow = {
  project_id: string;
  doc_count: number;
  project_name?: string | null;
  created_at?: string | null;
  repo_url?: string | null;
  repo_provider?: string | null;
};

export const PAGE_SIZES = [10, 20, 50] as const;
export const SEARCH_DEBOUNCE_MS = 350;

/** 概览快捷入口：统一为 outline 形（边框+阴影+高度），仅用颜色区分 */
export const DASHBOARD_ACTION_CLASS = "h-9 min-w-[8.5rem] justify-center px-4 shadow-sm transition-colors";
