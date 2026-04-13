export type UsageRow = {
  provider?: string;
  feature?: string;
  calls?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type DailyUsageRow = {
  day: string;
  calls?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type UsageSummary = {
  days: number;
  totals: {
    calls: number;
    success_calls: number;
    failed_calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  by_provider: UsageRow[];
  by_feature: UsageRow[];
  by_day: DailyUsageRow[];
};

export type Point = { x: number; y: number };

export const DAY_OPTIONS = [7, 30, 90] as const;
export const CHART_VIEW_WIDTH = 1000;
export const CHART_LEFT_PADDING = 64;
export const CHART_RIGHT_PADDING = 24;
export const CHART_LEGEND_LEFT_PADDING_PERCENT = `${(CHART_LEFT_PADDING / CHART_VIEW_WIDTH) * 100}%`;
export const CHART_LEGEND_RIGHT_PADDING_PERCENT = `${(CHART_RIGHT_PADDING / CHART_VIEW_WIDTH) * 100}%`;
export const PROMPT_LINE_COLOR = "rgb(96 165 250)";
export const COMPLETION_LINE_COLOR = "rgb(52 211 153)";
export const SHOW_Y_AXIS_LINE = false;
export const SOFT_CARD_BORDER_CLASS = "border-border/40";
export const SOFT_INNER_BORDER_CLASS = "border-border/35";
export const SUMMARY_LABEL_CLASS = "text-xs text-muted-foreground";
export const SUMMARY_VALUE_CLASS = "text-2xl font-semibold tracking-tight tabular-nums";
