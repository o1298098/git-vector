export type Job = {
  job_id: string;
  project_id: string;
  project_name: string | null;
  status: string;
  progress: number;
  step: string;
  message: string;
  is_current: boolean;
};

export const PAGE_SIZES = [10, 20, 50] as const;
