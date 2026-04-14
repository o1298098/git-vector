import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";
import { SOFT_CARD_BORDER_CLASS, SUMMARY_LABEL_CLASS, SUMMARY_VALUE_CLASS, type UsageSummary } from "../types";
import { compactNum, numberText } from "../utils";

type UsageSummaryCardsProps = {
  totals: UsageSummary["totals"];
};

export function UsageSummaryCards({ totals }: UsageSummaryCardsProps) {
  const { t, locale } = useI18n();
  const numberLocale = locale === "zh" ? "zh-CN" : "en-US";

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader className="space-y-1.5 pb-2">
          <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.totalTokens")}</CardDescription>
          <CardTitle className={SUMMARY_VALUE_CLASS}>
            <span title={numberText(totals.total_tokens, numberLocale)}>{compactNum(totals.total_tokens)}</span>
          </CardTitle>
        </CardHeader>
      </Card>
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader className="space-y-1.5 pb-2">
          <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.inputTokens")}</CardDescription>
          <CardTitle className={SUMMARY_VALUE_CLASS}>
            <span title={numberText(totals.prompt_tokens, numberLocale)}>{compactNum(totals.prompt_tokens)}</span>
          </CardTitle>
        </CardHeader>
      </Card>
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader className="space-y-1.5 pb-2">
          <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.outputTokens")}</CardDescription>
          <CardTitle className={SUMMARY_VALUE_CLASS}>
            <span title={numberText(totals.completion_tokens, numberLocale)}>{compactNum(totals.completion_tokens)}</span>
          </CardTitle>
        </CardHeader>
      </Card>
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader className="space-y-1.5 pb-2">
          <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.totalCalls")}</CardDescription>
          <CardTitle className={SUMMARY_VALUE_CLASS}>{numberText(totals.calls, numberLocale)}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("usage.avgLatency")}: {numberText(Math.round(totals.avg_latency_ms || 0), numberLocale)} ms
          </p>
        </CardHeader>
      </Card>
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader className="space-y-1.5 pb-2">
          <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.successFailCalls")}</CardDescription>
          <CardTitle className={SUMMARY_VALUE_CLASS}>
            {numberText(totals.success_calls, numberLocale)} / {numberText(totals.failed_calls, numberLocale)}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("usage.estimatedCost")}: ${Number(totals.estimated_cost_usd || 0).toFixed(4)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("usage.feedbackSummary")}: {numberText(totals.feedback_positive, numberLocale)} /{" "}
            {numberText(totals.feedback_negative, numberLocale)}
          </p>
        </CardHeader>
      </Card>
    </div>
  );
}
