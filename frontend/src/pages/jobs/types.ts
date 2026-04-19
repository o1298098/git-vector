export type Job = {
  job_id: string;
  project_id: string;
  project_name: string | null;
  job_type?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
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

export type JobLogEntry = {
  id: number;
  sequence: number;
  created_at: string;
  level: string;
  step?: string | null;
  message: string;
  source: string;
};

export type JobLogsResponse = {
  job_id: string;
  total: number;
  limit: number;
  offset: number;
  logs: JobLogEntry[];
};

export const PAGE_SIZES = [10, 20, 50] as const;
