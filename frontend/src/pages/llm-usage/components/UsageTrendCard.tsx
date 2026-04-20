import { useEffect, useRef, useState } from "react";
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

type ChartViewport = {
  width: number;
  height: number;
};

const BASE_CHART_WIDTH = 1000;
const BASE_CHART_HEIGHT = 240;

function scalePath(path: string, scaleX: number, scaleY: number) {
  return path.replace(/-?\d*\.?\d+/g, (token, index, full) => {
    const prev = full[index - 1];
    if (prev === "e" || prev === "E") return token;
    const value = Number(token);
    if (Number.isNaN(value)) return token;
    const prefix = full.slice(0, index);
    const commandMatch = prefix.match(/[A-Za-z](?=[^A-Za-z]*$)/);
    const command = commandMatch?.[0] ?? "";
    const tail = prefix.slice((commandMatch?.index ?? prefix.length - 1) + 1);
    const axisIndex = tail.split(",").length - 1;
    const isVerticalOnly = command === "V" || command === "v";
    const isHorizontalOnly = command === "H" || command === "h";
    const scaled = isVerticalOnly ? value * scaleY : isHorizontalOnly ? value * scaleX : axisIndex % 2 === 0 ? value * scaleX : value * scaleY;
    return Number(scaled.toFixed(2)).toString();
  });
}

export function UsageTrendCard({ trendRows, trendMode, trendChart }: UsageTrendCardProps) {
  const { t, locale } = useI18n();
  const singlePoint = trendRows.length === 1;
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<ChartViewport>({ width: BASE_CHART_WIDTH, height: BASE_CHART_HEIGHT });
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
  const scaleX = viewport.width / BASE_CHART_WIDTH;
  const scaleY = viewport.height / BASE_CHART_HEIGHT;
  const strokeScale = Math.min(scaleX, scaleY);
  const axisStrokeWidth = Math.max(0.8, Number((0.8 * strokeScale).toFixed(2)));
  const trendStrokeWidth = 1.5;
  const guideDash = `${Math.max(3, Math.round(4 * strokeScale))} ${Math.max(3, Math.round(4 * strokeScale))}`;
  const crosshairDash = `${Math.max(2, Math.round(3 * strokeScale))} ${Math.max(2, Math.round(3 * strokeScale))}`;
  const activePointRadius = 3.2;
  const lastPointRadius = 3;
  const scaledLeft = trendChart.left * scaleX;
  const scaledRight = trendChart.right * scaleX;
  const scaledMid = trendChart.mid * scaleX;
  const scaledTop = trendChart.top * scaleY;
  const scaledAxisBottom = trendChart.axisBottom * scaleY;
  const activeX =
    activeIndex == null
      ? null
      : singlePoint
        ? scaledMid
        : scaledLeft + ((scaledRight - scaledLeft) * activeIndex) / Math.max(1, trendRows.length - 1);
  const activeXPercent = activeX == null ? "50%" : `${(activeX / Math.max(1, viewport.width)) * 100}%`;
  const chartHeight = scaledAxisBottom - scaledTop;
  const yAxisLabelLeft = `${((scaledLeft - 10) / Math.max(1, viewport.width)) * 100}%`;
  const xAxisLabelTop = `${((scaledAxisBottom + 18) / Math.max(1, viewport.height)) * 100}%`;
  const xAxisLabels = singlePoint
    ? [{ key: "single", left: `${(scaledMid / Math.max(1, viewport.width)) * 100}%`, text: formatLabel(trendRows[0]?.day || ""), align: "center" as const }]
    : [
        { key: "start", left: `${(scaledLeft / Math.max(1, viewport.width)) * 100}%`, text: formatLabel(trendRows[0]?.day || ""), align: "left" as const },
        {
          key: "middle",
          left: `${(scaledMid / Math.max(1, viewport.width)) * 100}%`,
          text: formatLabel(trendRows[Math.floor((trendRows.length - 1) / 2)]?.day || ""),
          align: "center" as const,
        },
        {
          key: "end",
          left: `${(scaledRight / Math.max(1, viewport.width)) * 100}%`,
          text: formatLabel(trendRows[trendRows.length - 1]?.day || ""),
          align: "right" as const,
        },
      ];
  const promptY = activeRow == null ? null : scaledAxisBottom - (chartHeight * Number(activeRow.prompt_tokens || 0)) / chartMax;
  const completionY =
    activeRow == null ? null : scaledAxisBottom - (chartHeight * Number(activeRow.completion_tokens || 0)) / chartMax;
  const scaledPromptLine = scalePath(trendChart.promptLine, scaleX, scaleY);
  const scaledCompletionLine = scalePath(trendChart.completionLine, scaleX, scaleY);
  const scaledPromptArea = scalePath(trendChart.promptArea, scaleX, scaleY);
  const scaledCompletionArea = scalePath(trendChart.completionArea, scaleX, scaleY);
  const scaledPromptLast = trendChart.promptLast
    ? { x: trendChart.promptLast.x * scaleX, y: trendChart.promptLast.y * scaleY }
    : null;
  const scaledCompletionLast = trendChart.completionLast
    ? { x: trendChart.completionLast.x * scaleX, y: trendChart.completionLast.y * scaleY }
    : null;
  const scaledYTicks = trendChart.yTicks.map((tick) => ({ ...tick, y: tick.y * scaleY }));

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;

    const updateViewport = () => {
      const nextWidth = Math.max(1, Math.round(element.clientWidth));
      const nextHeight = Math.max(1, Math.round(element.clientHeight));
      setViewport((current) =>
        current.width === nextWidth && current.height === nextHeight ? current : { width: nextWidth, height: nextHeight },
      );
    };

    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
            <div ref={chartRef} className="relative w-full aspect-[1000/240]">
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
              {trendChart.yTicks.map((tick) => (
                <div
                  key={`tick-label-${tick.y}`}
                  className="pointer-events-none absolute -translate-y-1/2 text-[11px] leading-none text-muted-foreground/70"
                  style={{ left: yAxisLabelLeft, top: `${(tick.y / 240) * 100}%`, transform: "translate(-100%, -50%)" }}
                >
                  {compactNum(tick.value)}
                </div>
              ))}
              {xAxisLabels.map((label) => (
                <div
                  key={label.key}
                  className="pointer-events-none absolute text-xs leading-none text-muted-foreground/80"
                  style={{
                    left: label.left,
                    top: xAxisLabelTop,
                    transform:
                      label.align === "left"
                        ? "translateX(0)"
                        : label.align === "right"
                          ? "translateX(-100%)"
                          : "translateX(-50%)",
                  }}
                >
                  {label.text}
                </div>
              ))}
              <svg
                width={viewport.width}
                height={viewport.height}
                viewBox={`0 0 ${viewport.width} ${viewport.height}`}
                className="h-full w-full overflow-visible"
                shapeRendering="geometricPrecision"
                textRendering="geometricPrecision"
                onMouseLeave={() => setHoverIndex(null)}
                onMouseMove={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (rect.width <= 0 || trendRows.length === 0) return;
                  const x = ((event.clientX - rect.left) / rect.width) * viewport.width;
                  const clamped = Math.max(scaledLeft, Math.min(scaledRight, x));
                  if (trendRows.length === 1) {
                    setHoverIndex(0);
                    return;
                  }
                  const ratio = (clamped - scaledLeft) / Math.max(1, scaledRight - scaledLeft);
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
                x1={scaledLeft}
                y1={scaledAxisBottom}
                x2={scaledRight}
                y2={scaledAxisBottom}
                stroke="currentColor"
                opacity="0.18"
                strokeWidth={axisStrokeWidth}
              />
              {SHOW_Y_AXIS_LINE ? (
                <line
                  x1={scaledLeft}
                  y1={scaledTop}
                  x2={scaledLeft}
                  y2={scaledAxisBottom}
                  stroke="currentColor"
                  opacity="0.14"
                  strokeWidth={axisStrokeWidth}
                />
              ) : null}
              {scaledYTicks
                .filter((tick) => tick.y !== scaledAxisBottom)
                .map((tick) => (
                  <line
                    key={`grid-${tick.y}`}
                    x1={scaledLeft}
                    y1={tick.y}
                    x2={scaledRight}
                    y2={tick.y}
                    stroke="currentColor"
                    opacity="0.1"
                    strokeWidth={axisStrokeWidth}
                    strokeDasharray={guideDash}
                  />
                ))}

              <path d={scaledPromptArea} fill="url(#usagePromptFill)" />
              <path d={scaledCompletionArea} fill="url(#usageCompletionFill)" />

              <path
                d={scaledPromptLine}
                fill="none"
                stroke={PROMPT_LINE_COLOR}
                strokeWidth={trendStrokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={scaledCompletionLine}
                fill="none"
                stroke={COMPLETION_LINE_COLOR}
                strokeWidth={trendStrokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />

              {activeRow && activeX != null ? (
                <>
                  <line
                    x1={activeX}
                    y1={scaledTop}
                    x2={activeX}
                    y2={scaledAxisBottom}
                    stroke="currentColor"
                    opacity="0.22"
                    strokeDasharray={crosshairDash}
                  />
                  {promptY != null ? <circle cx={activeX} cy={promptY} r={activePointRadius} fill={PROMPT_LINE_COLOR} /> : null}
                  {completionY != null ? <circle cx={activeX} cy={completionY} r={activePointRadius} fill={COMPLETION_LINE_COLOR} /> : null}
                </>
              ) : null}

              {scaledPromptLast ? <circle cx={scaledPromptLast.x} cy={scaledPromptLast.y} r={lastPointRadius} fill={PROMPT_LINE_COLOR} /> : null}
              {scaledCompletionLast ? (
                <circle cx={scaledCompletionLast.x} cy={scaledCompletionLast.y} r={lastPointRadius} fill={COMPLETION_LINE_COLOR} />
              ) : null}

              </svg>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
