import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "@/lib/api";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { UsageBreakdownCards } from "./components/UsageBreakdownCards";
import { UsageSummaryCards } from "./components/UsageSummaryCards";
import { UsageTrendCard } from "./components/UsageTrendCard";
import { DAY_OPTIONS, type UsageSummary } from "./types";
import { computeTrendChart } from "./utils";

const USAGE_DAYS_STORAGE_KEY = "gv.llmUsage.days";

function readInitialDays(): number {
  const fallback = 30;
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(USAGE_DAYS_STORAGE_KEY);
    const n = Number(raw);
    return DAY_OPTIONS.some((v) => v === n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export function LlmUsage() {
  const { t } = useI18n();
  const [days, setDays] = useState<number>(() => readInitialDays());
  const tzOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<UsageSummary | null>(null);
  const requestSeqRef = useRef(0);
  const inflightControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inflightControllerRef.current?.abort();
    const controller = new AbortController();
    inflightControllerRef.current = controller;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    setLoading(true);
    setError(null);
    try {
      const result = await apiJson<UsageSummary>(
        `/api/admin/llm-usage?days=${days}&tz_offset_minutes=${tzOffsetMinutes}`,
        { signal: controller.signal },
      );
      if (requestSeq !== requestSeqRef.current) return;
      setData(result);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      if (requestSeq !== requestSeqRef.current) return;
      setError(err instanceof Error ? err.message : t("usage.loadFail"));
    } finally {
      if (requestSeq !== requestSeqRef.current) return;
      setLoading(false);
    }
  }, [days, t, tzOffsetMinutes]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      inflightControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(USAGE_DAYS_STORAGE_KEY, String(days));
    } catch {
      /* ignore localStorage failures */
    }
  }, [days]);

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
  const effectiveDays = typeof data?.days === "number" ? data.days : days;
  const trendMode = effectiveDays === 1 ? "hour" : "day";
  const trendRows = useMemo(
    () =>
      trendMode === "hour"
        ? (data?.by_hour ?? []).map((row) => ({
            day: row.hour,
            calls: row.calls,
            prompt_tokens: row.prompt_tokens,
            completion_tokens: row.completion_tokens,
            total_tokens: row.total_tokens,
          }))
        : (data?.by_day ?? []),
    [data?.by_day, data?.by_hour, trendMode],
  );
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
  const showRefreshingOverlay = loading && data !== null;

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
            onChange={(event) => {
              const next = Number(event.target.value);
              setDays(DAY_OPTIONS.some((v) => v === next) ? next : 30);
            }}
            disabled={loading}
          >
            {DAY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === 1 ? t("usage.today") : t("usage.days", { n: String(option) })}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{t("usage.loadFail")}</div> : null}

      <div className="relative">
        <div className={cn("space-y-6 transition-opacity duration-300", showRefreshingOverlay ? "opacity-70" : "opacity-100")}>
          <UsageSummaryCards totals={totals} />
          <div className="grid gap-6 lg:grid-cols-2">
            <UsageTrendCard trendRows={trendRows} trendMode={trendMode} trendChart={trendChart} />
            <UsageBreakdownCards hasData={!!data} providerRows={providerRows} featureRows={featureRows} />
          </div>
        </div>
        {showRefreshingOverlay ? (
          <div
            role="status"
            aria-live="polite"
            aria-label="Refreshing usage data"
            className="pointer-events-none absolute inset-0 rounded-md bg-background/35 backdrop-blur-[1px]"
          />
        ) : null}
      </div>
    </div>
  );
}
