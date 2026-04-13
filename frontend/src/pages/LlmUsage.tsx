import { useCallback, useEffect, useMemo, useState } from "react";
import { apiJson } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";

type UsageRow = {
  provider?: string;
  feature?: string;
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
};

const DAY_OPTIONS = [7, 30, 90] as const;

function n(v: number | undefined): string {
  return Number(v || 0).toLocaleString();
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>{t("usage.totalTokens")}</CardDescription>
            <CardTitle className="text-2xl">{n(totals.total_tokens)}</CardTitle>
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
            <CardDescription>{t("usage.successCalls")}</CardDescription>
            <CardTitle className="text-2xl">{n(totals.success_calls)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardDescription>{t("usage.failedCalls")}</CardDescription>
            <CardTitle className="text-2xl">{n(totals.failed_calls)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("usage.byProvider")}</CardTitle>
            <CardDescription>{t("usage.byProviderDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {!data || providerRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("usage.empty")}</p>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <div className="grid grid-cols-[1fr_auto_auto] gap-2 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <span>{t("usage.colName")}</span>
                  <span>{t("usage.colCalls")}</span>
                  <span>{t("usage.colTokens")}</span>
                </div>
                {providerRows.map((r) => (
                  <div key={r.provider || "unknown"} className="grid grid-cols-[1fr_auto_auto] gap-2 border-t px-3 py-2 text-sm">
                    <span className="truncate">{r.provider || "unknown"}</span>
                    <span className="font-mono">{n(r.calls)}</span>
                    <span className="font-mono">{n(r.total_tokens)}</span>
                  </div>
                ))}
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
              <div className="overflow-hidden rounded-md border">
                <div className="grid grid-cols-[1fr_auto_auto] gap-2 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <span>{t("usage.colName")}</span>
                  <span>{t("usage.colCalls")}</span>
                  <span>{t("usage.colTokens")}</span>
                </div>
                {featureRows.map((r) => (
                  <div key={r.feature || "general"} className="grid grid-cols-[1fr_auto_auto] gap-2 border-t px-3 py-2 text-sm">
                    <span className="truncate" title={r.feature || "general"}>
                      {r.feature || "general"}
                    </span>
                    <span className="font-mono">{n(r.calls)}</span>
                    <span className="font-mono">{n(r.total_tokens)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
