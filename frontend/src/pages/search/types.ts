export type Hit = {
  score?: number | null;
  distance?: number | null;
  content: string;
  metadata?: Record<string, unknown>;
  source_url?: string;
  citation?: string;
};

export type ProjectOption = {
  project_id: string;
  project_name?: string | null;
};
