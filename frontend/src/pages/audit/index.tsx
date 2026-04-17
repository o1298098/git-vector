import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import type { DateRange } from "react-day-picker";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";

type AuditPayload = {
  provider?: string;
  model?: string;
  endpoint?: string;
  http_status_code?: number;
  ok?: boolean;
  latency_ms?: number;
  error_type?: string;
  error_message?: string;
  feature?: string;
  project_id?: string;
  stream?: boolean;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type AuditEvent = {
  id: number;
  created_at: string;
  event_type: string;
  actor: string;
  method: string;
  route: string;
  resource_type: string;
  resource_id: string;
  status: string;
  payload?: AuditPayload;
};

type AuditEventsResponse = {
  total: number;
  limit: number;
  offset: number;
  events: AuditEvent[];
};

type AuditRangePreset = "15m" | "1h" | "4h" | "24h" | "7d" | "custom";

const PAGE_SIZE_OPTIONS = [15, 30, 50, 100] as const;
const DEFAULT_PAGE_SIZE = PAGE_SIZE_OPTIONS[0];

function formatTime(raw: string): string {
  if (!raw) return "-";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

function formatPayloadField(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function getStatusTone(status: string): string {
  switch ((status || "").toLowerCase()) {
    case "ok":
      return "bg-emerald-500/8 text-emerald-700 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-300";
    case "error":
    case "failed":
      return "bg-destructive/8 text-destructive ring-1 ring-inset ring-destructive/20";
    case "cancelled":
      return "bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-500/20 dark:text-amber-300";
    default:
      return "bg-muted text-muted-foreground ring-1 ring-inset ring-border/60";
  }
}

function isAbnormalStatus(status: string): boolean {
  return ["failed", "error", "cancelled"].includes((status || "").toLowerCase());
}

function getRequestSummary(row: AuditEvent): string {
  const route = row.route || "-";
  return `${row.method || "-"} ${route}`;
}

function getRowSummary(row: AuditEvent): string {
  const parts = [row.actor, row.payload?.provider, row.payload?.model, row.resource_id]
    .map((item) => formatPayloadField(item))
    .filter((item) => item !== "-");
  return parts.slice(0, 3).join(" · ") || "-";
}

function getPrimaryError(row: AuditEvent): string {
  const parts = [row.payload?.error_type, row.payload?.error_message]
    .map((item) => formatPayloadField(item))
    .filter((item) => item !== "-");
  return parts.join(" · ") || "-";
}

function DetailRow({ label, value }: { label: string; value: unknown }) {
  const displayValue = formatPayloadField(value);
  if (displayValue === "-") return null;

  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-start gap-x-3 py-1.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground/75">{label}</div>
      <div className="break-words text-[13px] leading-5 text-foreground/90">{displayValue}</div>
    </div>
  );
}

export function Audit() {
  const { t } = useI18n();
  const [eventType, setEventType] = useState("");
  const [status, setStatus] = useState("all");
  const [rangePreset, setRangePreset] = useState<AuditRangePreset>("24h");
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const [filters, setFilters] = useState<{
    eventType: string;
    status: string;
    createdFrom: string;
    createdTo: string;
  }>({
    eventType: "",
    status: "",
    createdFrom: dayjs().subtract(24, "hour").toISOString(),
    createdTo: dayjs().toISOString(),
  });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<AuditEvent[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [pageVisible, setPageVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  const requestSeqRef = useRef(0);
  const inflightControllerRef = useRef<AbortController | null>(null);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize) || 1), [pageSize, total]);
  const statusOptions = useMemo(
    () => ["ok", "failed", "disabled", "cancelled", "error"],
    [],
  );
  const rangeOptions = useMemo(
    () => [
      { value: "15m", label: t("audit.rangeLast15Minutes") },
      { value: "1h", label: t("audit.rangeLastHour") },
      { value: "4h", label: t("audit.rangeLast4Hours") },
      { value: "24h", label: t("audit.rangeLast24Hours") },
      { value: "7d", label: t("audit.rangeLast7Days") },
      { value: "custom", label: t("audit.rangeCustom") },
    ] satisfies { value: AuditRangePreset; label: string }[],
    [t],
  );

  function toIsoStartOfDay(d?: Date): string {
    if (!d) return "";
    return dayjs(d).startOf("day").toISOString();
  }

  function toIsoEndOfDay(d?: Date): string {
    if (!d) return "";
    return dayjs(d).endOf("day").toISOString();
  }

  function getPresetRange(preset: Exclude<AuditRangePreset, "custom">): { createdFrom: string; createdTo: string } {
    const now = dayjs();
    switch (preset) {
      case "15m":
        return { createdFrom: now.subtract(15, "minute").toISOString(), createdTo: now.toISOString() };
      case "1h":
        return { createdFrom: now.subtract(1, "hour").toISOString(), createdTo: now.toISOString() };
      case "4h":
        return { createdFrom: now.subtract(4, "hour").toISOString(), createdTo: now.toISOString() };
      case "7d":
        return { createdFrom: now.subtract(7, "day").toISOString(), createdTo: now.toISOString() };
      case "24h":
      default:
        return { createdFrom: now.subtract(24, "hour").toISOString(), createdTo: now.toISOString() };
    }
  }

  function getRangeLabel(): string {
    if (rangePreset !== "custom") {
      return rangeOptions.find((option) => option.value === rangePreset)?.label ?? t("audit.rangeLast24Hours");
    }
    if (dateRange?.from && dateRange?.to) {
      return `${dayjs(dateRange.from).format("YYYY/MM/DD")} - ${dayjs(dateRange.to).format("YYYY/MM/DD")}`;
    }
    if (dateRange?.from) {
      return `${dayjs(dateRange.from).format("YYYY/MM/DD")} - ...`;
    }
    return t("audit.customDatePlaceholder");
  }

  function applyFilters() {
    setPage(0);
    const nextRange =
      rangePreset === "custom"
        ? {
            createdFrom: toIsoStartOfDay(dateRange?.from),
            createdTo: toIsoEndOfDay(dateRange?.to ?? dateRange?.from),
          }
        : getPresetRange(rangePreset);
    setFilters({
      eventType: eventType.trim(),
      status: status.trim() === "all" ? "" : status.trim(),
      createdFrom: nextRange.createdFrom,
      createdTo: nextRange.createdTo,
    });
  }

  const load = useCallback(async () => {
    inflightControllerRef.current?.abort();
    const controller = new AbortController();
    inflightControllerRef.current = controller;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const showLoading = !hasLoadedOnce || rows.length === 0;
    if (showLoading) {
      setLoading(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("offset", String(page * pageSize));
      if (filters.eventType.trim()) params.set("event_type", filters.eventType.trim());
      if (filters.status.trim()) params.set("status", filters.status.trim());
      if (filters.createdFrom.trim()) params.set("created_from", filters.createdFrom.trim());
      if (filters.createdTo.trim()) params.set("created_to", filters.createdTo.trim());
      const data = await apiJson<AuditEventsResponse>(`/api/admin/audit-events?${params.toString()}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || seq !== requestSeqRef.current) return;
      const events = data.events || [];
      setRows(events);
      setTotal(typeof data.total === "number" ? data.total : 0);
      setHasLoadedOnce(true);
      setSelectedEventId((current) => {
        if (!events.length) return null;
        if (current && events.some((item) => item.id === current)) return current;
        return null;
      });
    } catch (err: unknown) {
      if (controller.signal.aborted || seq !== requestSeqRef.current) return;
      setError(err instanceof Error ? err.message : t("audit.loadFail"));
    } finally {
      if (controller.signal.aborted || seq !== requestSeqRef.current) return;
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [filters.createdFrom, filters.createdTo, filters.eventType, filters.status, hasLoadedOnce, page, pageSize, rows.length, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function onVisibilityChange() {
      setPageVisible(document.visibilityState === "visible");
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!autoRefresh || !pageVisible) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, load, pageVisible]);

  useEffect(
    () => () => {
      inflightControllerRef.current?.abort();
    },
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("audit.title")}</h1>
          <p className="text-muted-foreground">{t("audit.subtitle")}</p>
        </div>
      </div>

      <section className="rounded-lg border border-border/70 bg-background/60 p-4 shadow-sm">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_180px_220px_minmax(260px,320px)]">
            <div className="space-y-2">
              <Label htmlFor="audit-event-type">{t("audit.eventType")}</Label>
              <Input
                id="audit-event-type"
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                placeholder={t("audit.eventTypePh")}
                className="h-10 rounded-md"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="audit-status">{t("audit.status")}</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="audit-status" className="h-10 rounded-md">
                  <SelectValue placeholder={t("audit.statusAll")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("audit.statusAll")}</SelectItem>
                  {statusOptions.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 xl:w-[220px]">
              <Label htmlFor="audit-time-range">{t("audit.timeRange")}</Label>
              <Select
                value={rangePreset}
                onValueChange={(value) => {
                  setRangePreset(value as AuditRangePreset);
                  if (value !== "custom") {
                    setCustomRangeOpen(false);
                  }
                }}
              >
                <SelectTrigger id="audit-time-range" className="h-10 rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rangeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {rangePreset === "custom" ? (
              <div className="space-y-2 xl:w-full">
                <Label>{t("audit.customDateRange")}</Label>
                <Popover open={customRangeOpen} onOpenChange={setCustomRangeOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(
                        "h-10 w-full justify-between rounded-lg px-3 text-left font-normal",
                        !dateRange?.from && "text-muted-foreground",
                      )}
                    >
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <CalendarDays className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{getRangeLabel()}</span>
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto rounded-xl p-0" align="start">
                    <Calendar
                      mode="range"
                      numberOfMonths={2}
                      selected={dateRange}
                      defaultMonth={dateRange?.from}
                      onSelect={setDateRange}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <Button type="submit">{t("audit.applyFilter")}</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEventType("");
                setStatus("all");
                setRangePreset("24h");
                setDateRange(undefined);
                setCustomRangeOpen(false);
                setFilters({
                  eventType: "",
                  status: "",
                  ...getPresetRange("24h"),
                });
                setPage(0);
              }}
            >
              {t("audit.clearFilter")}
            </Button>
          </div>
        </form>
      </section>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-center gap-3">
            <div className="font-medium text-foreground/80">
              {t("audit.pageInfo", { total: String(total) })}
              {t("audit.pageNav", { cur: String(page + 1), all: String(totalPages) })}
              {t("audit.pageSize", { size: String(pageSize) })}
            </div>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-2">
              <Label htmlFor="audit-page-size" className="text-xs text-muted-foreground">
                {t("audit.perPage")}
              </Label>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value));
                  setPage(0);
                }}
              >
                <SelectTrigger id="audit-page-size" className="h-8 w-[84px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-2">
              <Switch id="audit-auto-refresh" checked={autoRefresh} onCheckedChange={setAutoRefresh} />
              <Label htmlFor="audit-auto-refresh" className="text-xs text-muted-foreground">
                {t("audit.autoRefresh", { status: autoRefresh ? t("audit.autoRefreshOn") : t("audit.autoRefreshOff") })}
              </Label>
            </div>
          </div>

          <div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/30 p-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              disabled={page <= 0}
              onClick={() => setPage(0)}
              aria-label={t("audit.first")}
              title={t("audit.first")}
            >
              <ChevronsLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              disabled={page <= 0}
              onClick={() => setPage((p) => p - 1)}
              aria-label={t("audit.prev")}
              title={t("audit.prev")}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              aria-label={t("audit.next")}
              title={t("audit.next")}
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage(Math.max(totalPages - 1, 0))}
              aria-label={t("audit.last")}
              title={t("audit.last")}
            >
              <ChevronsRight className="size-4" />
            </Button>
          </div>
        </div>

        <section className="overflow-hidden rounded-lg border border-border/70 bg-background/80 shadow-sm">
          <div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[172px] px-3.5 py-2.5">{t("audit.colTime")}</TableHead>
                  <TableHead className="px-3.5 py-2.5">{t("audit.colEventType")}</TableHead>
                  <TableHead className="w-[120px] px-3.5 py-2.5">{t("audit.colStatus")}</TableHead>
                  <TableHead className="px-3.5 py-2.5">{t("audit.colMethodRoute")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                      {loading ? t("common.loading") : t("audit.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => {
                    const expanded = selectedEventId === row.id;
                    const requestSummary = getRequestSummary(row);
                    const summary = getRowSummary(row);
                    const abnormal = isAbnormalStatus(row.status);
                    const primaryError = getPrimaryError(row);
                    return (
                      <>
                        <TableRow
                          key={row.id}
                          className={cn(
                            "cursor-pointer align-top transition-colors",
                            expanded && "bg-muted/60 hover:bg-muted/60",
                            abnormal && !expanded && "bg-destructive/[0.03] hover:bg-destructive/[0.06]",
                          )}
                          onClick={() => setSelectedEventId((current) => (current === row.id ? null : row.id))}
                        >
                          <TableCell className="px-3.5 py-3 align-top">
                            <div className="text-sm font-medium leading-5 text-foreground">{formatTime(row.created_at)}</div>
                          </TableCell>
                          <TableCell className="px-3.5 py-3 align-top">
                            <div className="flex items-start gap-1.5">
                              <ChevronDown
                                className={cn(
                                  "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
                                  expanded && "rotate-180 text-foreground",
                                )}
                                aria-hidden
                              />
                              <div className="min-w-0 space-y-1">
                                <div className="truncate text-sm font-medium leading-5 text-foreground" title={row.event_type}>
                                  {row.event_type}
                                </div>
                                <div className="truncate text-[11px] text-muted-foreground" title={summary}>
                                  {summary}
                                </div>
                                {abnormal && primaryError !== "-" ? (
                                  <div className="truncate text-[11px] font-medium text-destructive" title={primaryError}>
                                    {primaryError}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="px-3.5 py-3 align-top">
                            <span
                              className={cn(
                                "inline-flex min-w-[44px] items-center justify-center rounded-full px-2.5 py-1 text-[11px] font-medium leading-none tracking-[0.01em]",
                                getStatusTone(row.status),
                              )}
                            >
                              {row.status || "-"}
                            </span>
                          </TableCell>
                          <TableCell className="px-3.5 py-3 align-top">
                            <div className="truncate text-sm leading-5 text-foreground" title={requestSummary}>
                              {requestSummary}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                              <span>{row.resource_type || "-"}</span>
                              {row.resource_id ? (
                                <span className="truncate" title={row.resource_id}>
                                  {row.resource_id}
                                </span>
                              ) : null}
                              {row.payload?.http_status_code ? <span>HTTP {row.payload.http_status_code}</span> : null}
                            </div>
                          </TableCell>
                        </TableRow>
                        {expanded ? (
                          <TableRow key={`${row.id}-detail`} className="bg-background hover:bg-background">
                            <TableCell colSpan={4} className="border-t border-border/50 px-4 py-3.5">
                              <div className="space-y-3.5">
                                {primaryError !== "-" ? (
                                  <div className="rounded-md border border-destructive/20 bg-destructive/[0.03] px-2.5 py-2 text-[13px] leading-5 text-destructive">
                                    {primaryError}
                                  </div>
                                ) : null}

                                <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
                                  <section className="space-y-1.5">
                                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/75">
                                      {t("audit.sectionRequest")}
                                    </h3>
                                    <div className="divide-y divide-border/40 border-t border-border/40">
                                      <DetailRow label={t("audit.fieldMethod")} value={row.method} />
                                      <DetailRow label={t("audit.fieldRoute")} value={row.route} />
                                      <DetailRow label={t("audit.fieldResourceType")} value={row.resource_type} />
                                      <DetailRow label={t("audit.fieldResourceId")} value={row.resource_id} />
                                      <DetailRow label={t("audit.colTime")} value={formatTime(row.created_at)} />
                                      <DetailRow label={t("audit.colActor")} value={row.actor} />
                                    </div>
                                  </section>

                                  <section className="space-y-1.5">
                                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/75">
                                      {t("audit.sectionProvider")}
                                    </h3>
                                    <div className="divide-y divide-border/40 border-t border-border/40">
                                      <DetailRow label={t("audit.fieldProvider")} value={row.payload?.provider} />
                                      <DetailRow label={t("audit.fieldModel")} value={row.payload?.model} />
                                      <DetailRow label={t("audit.fieldEndpoint")} value={row.payload?.endpoint} />
                                      <DetailRow label={t("audit.fieldFeature")} value={row.payload?.feature} />
                                      <DetailRow label={t("audit.fieldStream")} value={row.payload?.stream} />
                                      <DetailRow label={t("audit.fieldProjectId")} value={row.payload?.project_id} />
                                      <DetailRow label={t("audit.fieldPromptTokens")} value={row.payload?.prompt_tokens} />
                                      <DetailRow label={t("audit.fieldCompletionTokens")} value={row.payload?.completion_tokens} />
                                      <DetailRow label={t("audit.fieldTotalTokens")} value={row.payload?.total_tokens} />
                                      <DetailRow label={t("audit.fieldHttpStatus")} value={row.payload?.http_status_code} />
                                      <DetailRow
                                        label={t("audit.fieldLatency")}
                                        value={row.payload?.latency_ms ? `${row.payload.latency_ms} ms` : "-"}
                                      />
                                      <DetailRow label={t("audit.fieldOk")} value={row.payload?.ok} />
                                      <DetailRow label={t("audit.fieldErrorType")} value={row.payload?.error_type} />
                                      <DetailRow label={t("audit.fieldErrorMessage")} value={row.payload?.error_message} />
                                    </div>
                                  </section>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>
    </div>
  );
}
