export type Job = {
  job_id: string;
  project_id: string;
  project_name: string | null;
  status: string;
  progress: number;
  step: string;
  message: string;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  failure_reason?: string | null;
  log_excerpt?: string | null;
  is_current: boolean;
};

export const PAGE_SIZES = [10, 20, 50] as const;
