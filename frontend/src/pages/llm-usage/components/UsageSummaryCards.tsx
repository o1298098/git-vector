import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";
import { SOFT_CARD_BORDER_CLASS, SUMMARY_LABEL_CLASS, SUMMARY_VALUE_CLASS, type UsageSummary } from "../types";
import { compactNum, numberText } from "../utils";

type UsageSummaryCardsProps = {
  totals: UsageSummary["totals"];
};

export function UsageSummaryCards({ totals }: UsageSummaryCardsProps) {
  const { t } = useI18n();

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader className="space-y-1.5 pb-2">
          <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.totalTokens")}</CardDescription>
          <CardTitle className={SUMMARY_VALUE_CLASS}>
            <span title={numberText(totals.total_tokens)}>{compactNum(totals.total_tokens)}</span>
          </CardTitle>
        </CardHeader>
      </Card>
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader className="space-y-1.5 pb-2">
          <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.inputTokens")}</CardDescription>
          <CardTitle className={SUMMARY_VALUE_CLASS}>
            <span title={numberText(totals.prompt_tokens)}>{compactNum(totals.prompt_tokens)}</span>
          </CardTitle>
        </CardHeader>
      </Card>
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader className="space-y-1.5 pb-2">
          <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.outputTokens")}</CardDescription>
          <CardTitle className={SUMMARY_VALUE_CLASS}>
            <span title={numberText(totals.completion_tokens)}>{compactNum(totals.completion_tokens)}</span>
          </CardTitle>
        </CardHeader>
      </Card>
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader className="space-y-1.5 pb-2">
          <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.totalCalls")}</CardDescription>
          <CardTitle className={SUMMARY_VALUE_CLASS}>{numberText(totals.calls)}</CardTitle>
        </CardHeader>
      </Card>
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader className="space-y-1.5 pb-2">
          <CardDescription className={SUMMARY_LABEL_CLASS}>{t("usage.successFailCalls")}</CardDescription>
          <CardTitle className={SUMMARY_VALUE_CLASS}>
            {numberText(totals.success_calls)} / {numberText(totals.failed_calls)}
          </CardTitle>
        </CardHeader>
      </Card>
    </div>
  );
}
