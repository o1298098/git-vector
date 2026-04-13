import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";
import {
  CHART_LEGEND_LEFT_PADDING_PERCENT,
  CHART_LEGEND_RIGHT_PADDING_PERCENT,
  COMPLETION_LINE_COLOR,
  PROMPT_LINE_COLOR,
  SHOW_Y_AXIS_LINE,
  SOFT_CARD_BORDER_CLASS,
  type DailyUsageRow,
} from "../types";
import { compactNum, shortDayLabel } from "../utils";

type UsageTrendCardProps = {
  trendRows: DailyUsageRow[];
  trendChart: {
    promptLine: string;
    completionLine: string;
    promptArea: string;
    completionArea: string;
    promptLast: { x: number; y: number } | null;
    completionLast: { x: number; y: number } | null;
    left: number;
    right: number;
    mid: number;
    top: number;
    axisBottom: number;
    yTicks: Array<{ y: number; value: number }>;
  };
};

export function UsageTrendCard({ trendRows, trendChart }: UsageTrendCardProps) {
  const { t } = useI18n();

  return (
    <Card className={`lg:col-span-2 ${SOFT_CARD_BORDER_CLASS}`}>
      <CardHeader>
        <CardTitle>{t("usage.trendTitle")}</CardTitle>
        <CardDescription>{t("usage.trendDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-3">
        {trendRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("usage.empty")}</p>
        ) : (
          <div className="space-y-3">
            <div
              className="flex items-center gap-4 text-xs text-muted-foreground"
              style={{ paddingLeft: CHART_LEGEND_LEFT_PADDING_PERCENT, paddingRight: CHART_LEGEND_RIGHT_PADDING_PERCENT }}
            >
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: PROMPT_LINE_COLOR }} />
                {t("usage.inputTokens")}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COMPLETION_LINE_COLOR }} />
                {t("usage.outputTokens")}
              </span>
            </div>
            <svg viewBox="0 0 1000 240" preserveAspectRatio="none" className="h-56 w-full overflow-visible">
              <defs>
                <linearGradient id="usagePromptFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PROMPT_LINE_COLOR} stopOpacity="0.22" />
                  <stop offset="100%" stopColor={PROMPT_LINE_COLOR} stopOpacity="0.02" />
                </linearGradient>
                <linearGradient id="usageCompletionFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COMPLETION_LINE_COLOR} stopOpacity="0.2" />
                  <stop offset="100%" stopColor={COMPLETION_LINE_COLOR} stopOpacity="0.02" />
                </linearGradient>
              </defs>

              <line
                x1={trendChart.left}
                y1={trendChart.axisBottom}
                x2={trendChart.right}
                y2={trendChart.axisBottom}
                stroke="currentColor"
                opacity="0.18"
                strokeWidth="0.8"
              />
              {SHOW_Y_AXIS_LINE ? (
                <line
                  x1={trendChart.left}
                  y1={trendChart.top}
                  x2={trendChart.left}
                  y2={trendChart.axisBottom}
                  stroke="currentColor"
                  opacity="0.14"
                  strokeWidth="0.8"
                />
              ) : null}
              {trendChart.yTicks
                .filter((tick) => tick.y !== trendChart.axisBottom)
                .map((tick) => (
                  <line
                    key={`grid-${tick.y}`}
                    x1={trendChart.left}
                    y1={tick.y}
                    x2={trendChart.right}
                    y2={tick.y}
                    stroke="currentColor"
                    opacity="0.1"
                    strokeWidth="0.8"
                    strokeDasharray="4 4"
                  />
                ))}
              {trendChart.yTicks.map((tick) => (
                <text
                  key={`tick-${tick.y}`}
                  x={trendChart.left - 10}
                  y={tick.y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fill="currentColor"
                  opacity="0.62"
                  fontSize="11"
                >
                  {compactNum(tick.value)}
                </text>
              ))}

              <path d={trendChart.promptArea} fill="url(#usagePromptFill)" />
              <path d={trendChart.completionArea} fill="url(#usageCompletionFill)" />

              <path
                d={trendChart.promptLine}
                fill="none"
                stroke={PROMPT_LINE_COLOR}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={trendChart.completionLine}
                fill="none"
                stroke={COMPLETION_LINE_COLOR}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {trendChart.promptLast ? <circle cx={trendChart.promptLast.x} cy={trendChart.promptLast.y} r="3" fill={PROMPT_LINE_COLOR} /> : null}
              {trendChart.completionLast ? (
                <circle cx={trendChart.completionLast.x} cy={trendChart.completionLast.y} r="3" fill={COMPLETION_LINE_COLOR} />
              ) : null}

              <text x={trendChart.left} y="228" textAnchor="start" fill="currentColor" opacity="0.7" fontSize="12">
                {shortDayLabel(trendRows[0]?.day || "")}
              </text>
              <text x={trendChart.mid} y="228" textAnchor="middle" fill="currentColor" opacity="0.7" fontSize="12">
                {shortDayLabel(trendRows[Math.floor((trendRows.length - 1) / 2)]?.day || "")}
              </text>
              <text x={trendChart.right} y="228" textAnchor="end" fill="currentColor" opacity="0.7" fontSize="12">
                {shortDayLabel(trendRows[trendRows.length - 1]?.day || "")}
              </text>
            </svg>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
