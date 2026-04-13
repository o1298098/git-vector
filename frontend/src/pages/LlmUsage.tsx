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

function n(v: number | undefined): string {
  return Number(v || 0).toLocaleString();
}

function shortDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return `${d.getMonth() + 1}/${d.getDate()}`;
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

  const trendPoints = useMemo(() => {
    if (trendRows.length === 0) return { prompt: "", completion: "" };
    const W = 1000;
    const H = 240;
    const L = 48;
    const R = 12;
    const T = 12;
    const B = 32;
    const innerW = W - L - R;
    const innerH = H - T - B;
    const len = Math.max(1, trendRows.length - 1);
    const promptPts: string[] = [];
    const completionPts: string[] = [];
    trendRows.forEach((r, i) => {
      const x = L + (innerW * i) / len;
      const p = Number(r.prompt_tokens || 0);
      const c = Number(r.completion_tokens || 0);
      const py = T + innerH - (innerH * p) / trendMax;
      const cy = T + innerH - (innerH * c) / trendMax;
      promptPts.push(`${x},${py}`);
      completionPts.push(`${x},${cy}`);
    });
    return { prompt: promptPts.join(" "), completion: completionPts.join(" ") };
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
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>{t("usage.totalTokens")}</CardDescription>
            <CardTitle className="text-2xl">{n(totals.total_tokens)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>{t("usage.inputTokens")}</CardDescription>
            <CardTitle className="text-2xl">{n(totals.prompt_tokens)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>{t("usage.outputTokens")}</CardDescription>
            <CardTitle className="text-2xl">{n(totals.completion_tokens)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>{t("usage.totalCalls")}</CardDescription>
            <CardTitle className="text-2xl">{n(totals.calls)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>{t("usage.successFailCalls")}</CardDescription>
            <CardTitle className="text-2xl">
              {n(totals.success_calls)} / {n(totals.failed_calls)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("usage.trendTitle")}</CardTitle>
            <CardDescription>{t("usage.trendDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {trendRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("usage.empty")}</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-600" />
                    {t("usage.inputTokens")}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-600" />
                    {t("usage.outputTokens")}
                  </span>
                </div>
                <svg viewBox="0 0 1000 240" className="h-56 w-full">
                  <line x1="48" y1="208" x2="988" y2="208" stroke="currentColor" opacity="0.2" />
                  <line x1="48" y1="12" x2="48" y2="208" stroke="currentColor" opacity="0.2" />
                  <polyline
                    fill="none"
                    stroke="rgb(37 99 235)"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={trendPoints.prompt}
                  />
                  <polyline
                    fill="none"
                    stroke="rgb(5 150 105)"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={trendPoints.completion}
                  />
                </svg>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{shortDayLabel(trendRows[0]?.day || "")}</span>
                  <span>{shortDayLabel(trendRows[Math.floor((trendRows.length - 1) / 2)]?.day || "")}</span>
                  <span>{shortDayLabel(trendRows[trendRows.length - 1]?.day || "")}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("usage.byProvider")}</CardTitle>
            <CardDescription>{t("usage.byProviderDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {!data || providerRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("usage.empty")}</p>
            ) : (
              <div className="rounded-md border">
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

        <Card>
          <CardHeader>
            <CardTitle>{t("usage.byFeature")}</CardTitle>
            <CardDescription>{t("usage.byFeatureDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {!data || featureRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("usage.empty")}</p>
            ) : (
              <div className="rounded-md border">
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
