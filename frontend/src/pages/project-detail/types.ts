import type { Job } from "@/pages/jobs/types";

export type ProjectSummary = {
  project_id: string;
  project_name?: string | null;
  doc_count: number;
  repo_provider?: string | null;
  repo_provider_override?: string | null;
  repo_web_base_url?: string | null;
  repo_url?: string | null;
  last_indexed_commit?: string | null;
  last_analyzed_commit?: string | null;
  last_impact_job_id?: string | null;
  last_local_repo_path?: string | null;
  latest_job?: {
    job_id: string;
    job_type: string;
    status: string;
    created_at?: string | null;
    finished_at?: string | null;
  } | null;
  issue_job_count: number;
  impact_run_count: number;
  latest_impact?: {
    job_id: string;
    commit_sha?: string | null;
    risk_level?: string | null;
    created_at?: string | null;
  } | null;
  job_count: number;
};

export type IssueRules = {
  project_id: string;
  auto_post_default: boolean;
  blocked_keywords: string[];
  require_human_keywords: string[];
  reply_template: string;
  reply_requirements: string;
  updated_at?: string | null;
};

export type ProjectIssueMessage = {
  id: string;
  role: "user" | "assistant";
  kind: string;
  author: string;
  body: string;
  created_at: string;
  url: string;
  provider: string;
  source: string;
  status: string;
};

export type ProjectIssueItem = {
  id: number;
  project_id: string;
  provider: string;
  issue_number: string;
  issue_url: string;
  repo_url: string;
  title: string;
  body: string;
  author: string;
  labels: string[];
  action: string;
  comments: string[];
  status: string;
  latest_reply_job_id: string;
  latest_reply_status: string;
  latest_reply_preview: string;
  latest_reply_posted_at: string;
  latest_reply_comment_url: string;
  latest_reply_error: string;
  created_at: string;
  updated_at: string;
};

export type ProjectIssueDetail = ProjectIssueItem & {
  messages?: ProjectIssueMessage[];
  latest_reply_job?: Job | null;
};

export type ProjectIssuesResponse = {
  total: number;
  limit: number;
  offset: number;
  issues: ProjectIssueItem[];
};

export type IssueLabelOptionsResponse = {
  project_id: string;
  provider: string;
  issue_number: string;
  current_labels: string[];
  available_labels: string[];
  supports_update: boolean;
};

export type UpdateIssueLabelsRequest = {
  labels: string[];
};

export type UpdateIssueLabelsResponse = {
  project_id: string;
  provider: string;
  issue_number: string;
  labels: string[];
  issue: ProjectIssueDetail | null;
  saved_locally: boolean;
};

export type IssueJobsResponse = {
  total: number;
  limit: number;
  offset: number;
  jobs: Job[];
};

export type ImpactRun = {
  id: number;
  job_id: string;
  project_id: string;
  repo_path: string;
  repo_url: string;
  branch: string;
  commit_sha: string;
  base_commit_sha: string;
  trigger_source: string;
  risk_level: string;
  status: string;
  summary: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ImpactRunsResponse = {
  total: number;
  limit: number;
  offset: number;
  runs: ImpactRun[];
};
