import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/I18nContext";
import { SOFT_CARD_BORDER_CLASS, SOFT_INNER_BORDER_CLASS, type UsageRow } from "../types";
import { compactNum, numberText } from "../utils";

type UsageBreakdownCardsProps = {
  hasData: boolean;
  providerRows: UsageRow[];
  featureRows: UsageRow[];
};

function UsageTable({ rows, nameKey }: { rows: UsageRow[]; nameKey: "provider" | "feature" }) {
  const { t, locale } = useI18n();
  const numberLocale = locale === "zh" ? "zh-CN" : "en-US";
  return (
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
          {rows.map((row) => {
            const label = nameKey === "provider" ? (row.provider || "unknown") : (row.feature || "general");
            return (
              <TableRow key={label}>
                <TableCell className="truncate" title={label}>
                  {label}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{numberText(row.calls, numberLocale)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums" title={numberText(row.prompt_tokens, numberLocale)}>
                  {compactNum(row.prompt_tokens)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums" title={numberText(row.completion_tokens, numberLocale)}>
                  {compactNum(row.completion_tokens)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums" title={numberText(row.total_tokens, numberLocale)}>
                  {compactNum(row.total_tokens)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function UsageBreakdownCards({ hasData, providerRows, featureRows }: UsageBreakdownCardsProps) {
  const { t } = useI18n();

  return (
    <>
      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader>
          <CardTitle>{t("usage.byProvider")}</CardTitle>
        </CardHeader>
        <CardContent>
          {!hasData || providerRows.length === 0 ? <p className="text-sm text-muted-foreground">{t("usage.empty")}</p> : <UsageTable rows={providerRows} nameKey="provider" />}
        </CardContent>
      </Card>

      <Card className={SOFT_CARD_BORDER_CLASS}>
        <CardHeader>
          <CardTitle>{t("usage.byFeature")}</CardTitle>
        </CardHeader>
        <CardContent>
          {!hasData || featureRows.length === 0 ? <p className="text-sm text-muted-foreground">{t("usage.empty")}</p> : <UsageTable rows={featureRows} nameKey="feature" />}
        </CardContent>
      </Card>
    </>
  );
}
