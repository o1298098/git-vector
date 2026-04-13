import { useCallback, useEffect, useMemo, useState } from "react";
import { apiJson } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/I18nContext";

type UsageRow = {
  provider?: string;
  feature?: string;
  calls?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type DailyUsageRow = {
  day: string;
  calls?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type UsageSummary = {
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

const DAY_OPTIONS = [7, 30, 90] as const;
const CHART_VIEW_WIDTH = 1000;
const CHART_LEFT_PADDING = 64;
const CHART_RIGHT_PADDING = 24;
const CHART_LEGEND_LEFT_PADDING_PERCENT = `${(CHART_LEFT_PADDING / CHART_VIEW_WIDTH) * 100}%`;
const CHART_LEGEND_RIGHT_PADDING_PERCENT = `${(CHART_RIGHT_PADDING / CHART_VIEW_WIDTH) * 100}%`;
const PROMPT_LINE_COLOR = "rgb(96 165 250)";
const COMPLETION_LINE_COLOR = "rgb(52 211 153)";
const SHOW_Y_AXIS_LINE = false;
const SOFT_CARD_BORDER_CLASS = "border-border/40";
const SOFT_INNER_BORDER_CLASS = "border-border/35";
const SUMMARY_LABEL_CLASS = "text-xs text-muted-foreground";
const SUMMARY_VALUE_CLASS = "text-2xl font-semibold tracking-tight tabular-nums";

function n(v: number | undefined): string {
  return Number(v || 0).toLocaleString();
}

function shortDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function compactNum(v: number | undefined): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(v || 0));
}

type Point = { x: number; y: number };

function smoothPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const cx = (p0.x + p1.x) / 2;
    d += ` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;
  }
  return d;
}

export function LlmUsage() {
  const { t } = useI18n();
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<UsageSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await apiJson<UsageSummary>(`/api/admin/llm-usage?days=${days}`);
      setData(res);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("usage.loadFail"));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    if (!data) {
      return {
        calls: 0,
        success_calls: 0,
        failed_calls: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
    }
    return data.totals;
  }, [data]);
  const providerRows = useMemo(() => data?.by_provider ?? [], [data?.by_provider]);
  const featureRows = useMemo(() => (data?.by_feature ?? []).slice(0, 10), [data?.by_feature]);
  const trendRows = useMemo(() => data?.by_day ?? [], [data?.by_day]);
  const trendMax = useMemo(() => {
    let maxV = 0;
    for (const r of trendRows) {
      const p = Number(r.prompt_tokens || 0);
      const c = Number(r.completion_tokens || 0);
      maxV = Math.max(maxV, p, c);
    }
    return maxV <= 0 ? 1 : maxV;
  }, [trendRows]);

  const trendChart = useMemo(() => {
    if (trendRows.length === 0) {
      const W = CHART_VIEW_WIDTH;
      const H = 240;
      const L = CHART_LEFT_PADDING;
      const R = CHART_RIGHT_PADDING;
      const T = 12;
      const B = 36;
      const baselineY = H - B;
      return {
        promptLine: "",
        completionLine: "",
        promptArea: "",
        completionArea: "",
        promptLast: null as Point | null,
        completionLast: null as Point | null,
        left: L,
        right: W - R,
        mid: (L + (W - R)) / 2,
        top: T,
        axisBottom: baselineY,
        yTicks: [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
          y: baselineY - (H - T - B) * ratio,
          value: 0,
        })),
      };
    }
    const W = CHART_VIEW_WIDTH;
    const H = 240;
    const L = CHART_LEFT_PADDING;
    const R = CHART_RIGHT_PADDING;
    const T = 12;
    const B = 36;
    const innerW = W - L - R;
    const innerH = H - T - B;
    const len = Math.max(1, trendRows.length - 1);
    const promptPts: Point[] = [];
    const completionPts: Point[] = [];
    trendRows.forEach((r, i) => {
      const x = L + (innerW * i) / len;
      const p = Number(r.prompt_tokens || 0);
      const c = Number(r.completion_tokens || 0);
      const py = T + innerH - (innerH * p) / trendMax;
      const cy = T + innerH - (innerH * c) / trendMax;
      promptPts.push({ x, y: py });
      completionPts.push({ x, y: cy });
    });
    const promptLine = smoothPath(promptPts);
    const completionLine = smoothPath(completionPts);
    const baselineY = T + innerH;
    const promptArea =
      promptPts.length > 0
        ? `${promptLine} L ${promptPts[promptPts.length - 1].x} ${baselineY} L ${promptPts[0].x} ${baselineY} Z`
        : "";
    const completionArea =
      completionPts.length > 0
        ? `${completionLine} L ${completionPts[completionPts.length - 1].x} ${baselineY} L ${completionPts[0].x} ${baselineY} Z`
        : "";
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
      y: baselineY - innerH * ratio,
      value: Math.round(trendMax * ratio),
    }));
    return {
      promptLine,
      completionLine,
      promptArea,
      completionArea,
      promptLast: promptPts[promptPts.length - 1] ?? null,
      completionLast: completionPts[completionPts.length - 1] ?? null,
      left: L,
      right: W - R,
      mid: L + innerW / 2,
      top: T,
      axisBottom: baselineY,
      yTicks,
    };
  }, [trendRows, trendMax]);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("usage.title")}</h1>
          <p className="text-muted-foreground">{t("usage.subtitle")}</p>
        </div>
        <label className="text-sm text-muted-foreground">
          {t("usage.range")}
          <select
            className="ml-2 h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={loading}
          >
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {t("usage.days", { n: String(d) })}
              </option>
            ))}
          </select>
        </label>
      </div>

      {err ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {t("usage.loadFail")}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Card className={SOFT_CARD_BORDER_CLASS}>
          <CardHeader className="space-y-1.5 pb-2">
            <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.totalTokens")}</CardDescription>
            <CardTitle className={SUMMARY_VALUE_CLASS}>{n(totals.total_tokens)}</CardTitle>
          </CardHeader>
        </Card>
        <Card className={SOFT_CARD_BORDER_CLASS}>
          <CardHeader className="space-y-1.5 pb-2">
            <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.inputTokens")}</CardDescription>
            <CardTitle className={SUMMARY_VALUE_CLASS}>{n(totals.prompt_tokens)}</CardTitle>
          </CardHeader>
        </Card>
        <Card className={SOFT_CARD_BORDER_CLASS}>
          <CardHeader className="space-y-1.5 pb-2">
            <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.outputTokens")}</CardDescription>
            <CardTitle className={SUMMARY_VALUE_CLASS}>{n(totals.completion_tokens)}</CardTitle>
          </CardHeader>
        </Card>
        <Card className={SOFT_CARD_BORDER_CLASS}>
          <CardHeader className="space-y-1.5 pb-2">
            <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.totalCalls")}</CardDescription>
            <CardTitle className={SUMMARY_VALUE_CLASS}>{n(totals.calls)}</CardTitle>
          </CardHeader>
        </Card>
        <Card className={SOFT_CARD_BORDER_CLASS}>
          <CardHeader className="space-y-1.5 pb-2">
            <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.successFailCalls")}</CardDescription>
            <CardTitle className={SUMMARY_VALUE_CLASS}>
              {n(totals.success_calls)} / {n(totals.failed_calls)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
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
                  style={{
                    paddingLeft: CHART_LEGEND_LEFT_PADDING_PERCENT,
                    paddingRight: CHART_LEGEND_RIGHT_PADDING_PERCENT,
                  }}
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

                  {trendChart.promptLast ? (
                    <circle cx={trendChart.promptLast.x} cy={trendChart.promptLast.y} r="3" fill={PROMPT_LINE_COLOR} />
                  ) : null}
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

        <Card className={SOFT_CARD_BORDER_CLASS}>
          <CardHeader>
            <CardTitle>{t("usage.byProvider")}</CardTitle>
          </CardHeader>
          <CardContent>
            {!data || providerRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("usage.empty")}</p>
            ) : (
              <div className={`rounded-md border ${SOFT_INNER_BORDER_CLASS}`}>
                <Table className="w-full table-fixed">
                  <colgroup>
                    <col className="w-[40%]" />
                    <col className="w-[12%]" />
                    <col className="w-[16%]" />
                    <col className="w-[16%]" />
                    <col className="w-[16%]" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("usage.colName")}</TableHead>
                      <TableHead className="text-right">{t("usage.colCalls")}</TableHead>
                      <TableHead className="text-right">{t("usage.colInputTokens")}</TableHead>
                      <TableHead className="text-right">{t("usage.colOutputTokens")}</TableHead>
                      <TableHead className="text-right">{t("usage.colTokens")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {providerRows.map((r) => (
                      <TableRow key={r.provider || "unknown"}>
                        <TableCell className="truncate">{r.provider || "unknown"}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{n(r.calls)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{n(r.prompt_tokens)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{n(r.completion_tokens)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{n(r.total_tokens)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={SOFT_CARD_BORDER_CLASS}>
          <CardHeader>
            <CardTitle>{t("usage.byFeature")}</CardTitle>
          </CardHeader>
          <CardContent>
            {!data || featureRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("usage.empty")}</p>
            ) : (
              <div className={`rounded-md border ${SOFT_INNER_BORDER_CLASS}`}>
                <Table className="w-full table-fixed">
                  <colgroup>
                    <col className="w-[40%]" />
                    <col className="w-[12%]" />
                    <col className="w-[16%]" />
                    <col className="w-[16%]" />
                    <col className="w-[16%]" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("usage.colName")}</TableHead>
                      <TableHead className="text-right">{t("usage.colCalls")}</TableHead>
                      <TableHead className="text-right">{t("usage.colInputTokens")}</TableHead>
                      <TableHead className="text-right">{t("usage.colOutputTokens")}</TableHead>
                      <TableHead className="text-right">{t("usage.colTokens")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {featureRows.map((r) => (
                      <TableRow key={r.feature || "general"}>
                        <TableCell className="truncate" title={r.feature || "general"}>
                          {r.feature || "general"}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{n(r.calls)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{n(r.prompt_tokens)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{n(r.completion_tokens)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{n(r.total_tokens)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
