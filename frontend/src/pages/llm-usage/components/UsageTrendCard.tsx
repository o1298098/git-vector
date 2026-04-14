import { useState } from "react";
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
import { compactNum, shortDayLabel, shortHourLabel } from "../utils";

type UsageTrendCardProps = {
  trendRows: DailyUsageRow[];
  trendMode: "day" | "hour";
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

export function UsageTrendCard({ trendRows, trendMode, trendChart }: UsageTrendCardProps) {
  const { t, locale } = useI18n();
  const singlePoint = trendRows.length === 1;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const formatLabel = (value: string) => (trendMode === "hour" ? shortHourLabel(value) : shortDayLabel(value));
  const chartMax = Math.max(1, trendChart.yTicks[trendChart.yTicks.length - 1]?.value ?? 1);
  const pointerIndex = hoverIndex == null ? null : Math.max(0, Math.min(trendRows.length - 1, hoverIndex));
  const activeIndex =
    focusIndex == null
      ? pointerIndex
      : Math.max(0, Math.min(trendRows.length - 1, focusIndex));
  const activeRow = activeIndex == null ? null : trendRows[activeIndex];
  const activeX =
    activeIndex == null
      ? null
      : singlePoint
        ? trendChart.mid
        : trendChart.left + ((trendChart.right - trendChart.left) * activeIndex) / Math.max(1, trendRows.length - 1);
  const activeXPercent = activeX == null ? "50%" : `${(activeX / 1000) * 100}%`;
  const chartHeight = trendChart.axisBottom - trendChart.top;
  const promptY =
    activeRow == null ? null : trendChart.axisBottom - (chartHeight * Number(activeRow.prompt_tokens || 0)) / chartMax;
  const completionY =
    activeRow == null ? null : trendChart.axisBottom - (chartHeight * Number(activeRow.completion_tokens || 0)) / chartMax;

  function formatTooltipTime(value: string): string {
    const date = value.includes("T") ? new Date(value) : new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    if (trendMode === "hour") {
      return date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US");
  }

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
            <div className="relative w-full aspect-[1000/240]">
              {activeRow ? (
                <div
                  className="pointer-events-none absolute top-2 z-10 min-w-[10rem] rounded-md border bg-background/95 px-2 py-1 text-xs shadow-sm"
                  style={{
                    left: activeXPercent,
                    transform:
                      activeX != null && activeX < 220
                        ? "translateX(0)"
                        : activeX != null && activeX > 780
                          ? "translateX(calc(-100% - 8px))"
                          : "translateX(-50%)",
                  }}
                >
                  <div className="font-medium">{formatTooltipTime(activeRow.day)}</div>
                  <div className="text-muted-foreground">
                    {t("usage.inputTokens")}: {compactNum(activeRow.prompt_tokens)}
                  </div>
                  <div className="text-muted-foreground">
                    {t("usage.outputTokens")}: {compactNum(activeRow.completion_tokens)}
                  </div>
                  <div className="text-muted-foreground">
                    {t("usage.totalTokens")}: {compactNum(activeRow.total_tokens)}
                  </div>
                  <div className="text-muted-foreground">
                    {t("usage.totalCalls")}: {compactNum(activeRow.calls)}
                  </div>
                </div>
              ) : null}
              <svg
                viewBox="0 0 1000 240"
                preserveAspectRatio="xMidYMid meet"
                className="h-full w-full overflow-visible"
                onMouseLeave={() => setHoverIndex(null)}
                onMouseMove={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (rect.width <= 0 || trendRows.length === 0) return;
                  const x = ((event.clientX - rect.left) / rect.width) * 1000;
                  const clamped = Math.max(trendChart.left, Math.min(trendChart.right, x));
                  if (trendRows.length === 1) {
                    setHoverIndex(0);
                    return;
                  }
                  const ratio = (clamped - trendChart.left) / Math.max(1, trendChart.right - trendChart.left);
                  const index = Math.round(ratio * (trendRows.length - 1));
                  setHoverIndex(index);
                }}
                tabIndex={0}
                role="img"
                aria-label={t("usage.trendTitle")}
                onFocus={() => {
                  if (trendRows.length > 0) setFocusIndex(trendRows.length - 1);
                }}
                onBlur={() => setFocusIndex(null)}
                onKeyDown={(event) => {
                  if (trendRows.length === 0) return;
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const current = focusIndex == null ? trendRows.length - 1 : focusIndex;
                  const delta = event.key === "ArrowLeft" ? -1 : 1;
                  const next = Math.max(0, Math.min(trendRows.length - 1, current + delta));
                  setFocusIndex(next);
                }}
              >
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

              {activeRow && activeX != null ? (
                <>
                  <line
                    x1={activeX}
                    y1={trendChart.top}
                    x2={activeX}
                    y2={trendChart.axisBottom}
                    stroke="currentColor"
                    opacity="0.22"
                    strokeDasharray="3 3"
                  />
                  {promptY != null ? <circle cx={activeX} cy={promptY} r="3.2" fill={PROMPT_LINE_COLOR} /> : null}
                  {completionY != null ? <circle cx={activeX} cy={completionY} r="3.2" fill={COMPLETION_LINE_COLOR} /> : null}
                </>
              ) : null}

              {trendChart.promptLast ? <circle cx={trendChart.promptLast.x} cy={trendChart.promptLast.y} r="3" fill={PROMPT_LINE_COLOR} /> : null}
              {trendChart.completionLast ? (
                <circle cx={trendChart.completionLast.x} cy={trendChart.completionLast.y} r="3" fill={COMPLETION_LINE_COLOR} />
              ) : null}

                {singlePoint ? (
                  <text x={trendChart.mid} y="228" textAnchor="middle" fill="currentColor" opacity="0.7" fontSize="12">
                    {formatLabel(trendRows[0]?.day || "")}
                  </text>
                ) : (
                  <>
                    <text x={trendChart.left} y="228" textAnchor="start" fill="currentColor" opacity="0.7" fontSize="12">
                      {formatLabel(trendRows[0]?.day || "")}
                    </text>
                    <text x={trendChart.mid} y="228" textAnchor="middle" fill="currentColor" opacity="0.7" fontSize="12">
                      {formatLabel(trendRows[Math.floor((trendRows.length - 1) / 2)]?.day || "")}
                    </text>
                    <text x={trendChart.right} y="228" textAnchor="end" fill="currentColor" opacity="0.7" fontSize="12">
                      {formatLabel(trendRows[trendRows.length - 1]?.day || "")}
                    </text>
                  </>
                )}
              </svg>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
