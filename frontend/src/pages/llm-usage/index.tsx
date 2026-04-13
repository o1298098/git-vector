import { useCallback, useEffect, useMemo, useState } from "react";
import { apiJson } from "@/lib/api";
import { useI18n } from "@/i18n/I18nContext";
import { UsageBreakdownCards } from "./components/UsageBreakdownCards";
import { UsageSummaryCards } from "./components/UsageSummaryCards";
import { UsageTrendCard } from "./components/UsageTrendCard";
import { DAY_OPTIONS, type UsageSummary } from "./types";
import { computeTrendChart } from "./utils";

export function LlmUsage() {
  const { t } = useI18n();
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<UsageSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiJson<UsageSummary>(`/api/admin/llm-usage?days=${days}`);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("usage.loadFail"));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(
    () =>
      data?.totals ?? {
        calls: 0,
        success_calls: 0,
        failed_calls: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    [data],
  );
  const providerRows = useMemo(() => data?.by_provider ?? [], [data?.by_provider]);
  const featureRows = useMemo(() => (data?.by_feature ?? []).slice(0, 10), [data?.by_feature]);
  const trendRows = useMemo(() => data?.by_day ?? [], [data?.by_day]);
  const trendMax = useMemo(() => {
    let maxValue = 0;
    for (const row of trendRows) {
      const prompt = Number(row.prompt_tokens || 0);
      const completion = Number(row.completion_tokens || 0);
      maxValue = Math.max(maxValue, prompt, completion);
    }
    return maxValue <= 0 ? 1 : maxValue;
  }, [trendRows]);
  const trendChart = useMemo(() => computeTrendChart(trendRows, trendMax), [trendRows, trendMax]);

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
            onChange={(event) => setDays(Number(event.target.value))}
            disabled={loading}
          >
            {DAY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {t("usage.days", { n: String(option) })}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{t("usage.loadFail")}</div> : null}
      <UsageSummaryCards totals={totals} />

      <div className="grid gap-6 lg:grid-cols-2">
        <UsageTrendCard trendRows={trendRows} trendChart={trendChart} />
        <UsageBreakdownCards hasData={!!data} providerRows={providerRows} featureRows={featureRows} />
      </div>
    </div>
  );
}
