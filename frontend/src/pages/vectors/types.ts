export type ProjectOption = {
  project_id: string;
  project_name?: string | null;
};

export type VectorRow = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
};

export type VectorListResp = {
  total: number;
  limit: number;
  offset: number;
  items: VectorRow[];
};

export const PAGE_SIZE = 20;
export const SEARCH_DEBOUNCE_MS = 300;
