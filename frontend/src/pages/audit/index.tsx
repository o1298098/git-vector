import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from "lucide-react";
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

const PAGE_SIZE_OPTIONS = [15,30, 50, 100] as const;
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

function formatAuditResource(row: AuditEvent): { primary: string; secondary: string } {
  return {
    primary: row.resource_type || "-",
    secondary: row.resource_id || "-",
  };
}

function getRequestSummary(row: AuditEvent): string {
  const route = row.route || "-";
  return `${row.method || "-"} ${route}`;
}

function isProviderEvent(row: AuditEvent): boolean {
  return row.event_type.startsWith("provider.");
}

function DetailRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[112px_minmax(0,1fr)] sm:gap-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="break-words text-sm text-foreground">{formatPayloadField(value)}</div>
    </div>
  );
}

export function Audit() {
  const { t } = useI18n();
  const [eventType, setEventType] = useState("");
  const [status, setStatus] = useState("all");
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [fromOpen, setFromOpen] = useState(false);
  const [toOpen, setToOpen] = useState(false);
  const [filters, setFilters] = useState<{
    eventType: string;
    status: string;
    createdFrom: string;
    createdTo: string;
  }>({
    eventType: "",
    status: "",
    createdFrom: "",
    createdTo: "",
  });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
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
  const selectedEvent = useMemo(
    () => rows.find((item) => item.id === selectedEventId) ?? rows[0] ?? null,
    [rows, selectedEventId],
  );

  function toIsoStartOfDay(d?: Date): string {
    if (!d) return "";
    return dayjs(d).startOf("day").toISOString();
  }

  function toIsoEndOfDay(d?: Date): string {
    if (!d) return "";
    return dayjs(d).endOf("day").toISOString();
  }

  const load = useCallback(async () => {
    inflightControllerRef.current?.abort();
    const controller = new AbortController();
    inflightControllerRef.current = controller;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setLoading(true);
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
      setSelectedEventId((current) => {
        if (!events.length) return null;
        if (current && events.some((item) => item.id === current)) return current;
        return events[0]?.id ?? null;
      });
    } catch (err: unknown) {
      if (controller.signal.aborted || seq !== requestSeqRef.current) return;
      setError(err instanceof Error ? err.message : t("audit.loadFail"));
    } finally {
      if (controller.signal.aborted || seq !== requestSeqRef.current) return;
      setLoading(false);
    }
  }, [filters.createdFrom, filters.createdTo, filters.eventType, filters.status, page, pageSize, t]);

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

      <section className="space-y-4 rounded-lg border border-border/70 bg-background/60 p-4 shadow-sm">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">
          <div className="space-y-2 xl:col-span-6">
            <Label htmlFor="audit-event-type">{t("audit.eventType")}</Label>
            <Input
              id="audit-event-type"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder={t("audit.eventTypePh")}
            />
          </div>
          <div className="space-y-2 xl:col-span-2">
            <Label htmlFor="audit-status">{t("audit.status")}</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="audit-status">
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
          <div className="space-y-2 xl:col-span-2">
            <Label>{t("audit.timeFrom")}</Label>
            <Popover open={fromOpen} onOpenChange={setFromOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn(
                    "relative h-10 w-full justify-between rounded-lg pr-11 text-left font-normal",
                    !dateFrom && "text-muted-foreground",
                  )}
                >
                  <span className="inline-flex items-center gap-2">
                    <CalendarDays className="size-4" aria-hidden />
                    {dateFrom ? dayjs(dateFrom).format("YYYY-MM-DD") : t("audit.datePlaceholder")}
                  </span>
                  {dateFrom ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={t("audit.clearFilter")}
                      className="absolute right-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDateFrom(undefined);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          setDateFrom(undefined);
                        }
                      }}
                    >
                      <X className="size-4" aria-hidden />
                    </span>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto rounded-xl p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateFrom}
                  onSelect={(date) => {
                    setDateFrom(date);
                    setFromOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
          <div className="space-y-2 xl:col-span-2">
            <Label>{t("audit.timeTo")}</Label>
            <Popover open={toOpen} onOpenChange={setToOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={cn(
                    "relative h-10 w-full justify-between rounded-lg pr-11 text-left font-normal",
                    !dateTo && "text-muted-foreground",
                  )}
                >
                  <span className="inline-flex items-center gap-2">
                    <CalendarDays className="size-4" aria-hidden />
                    {dateTo ? dayjs(dateTo).format("YYYY-MM-DD") : t("audit.datePlaceholder")}
                  </span>
                  {dateTo ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={t("audit.clearFilter")}
                      className="absolute right-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDateTo(undefined);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          setDateTo(undefined);
                        }
                      }}
                    >
                      <X className="size-4" aria-hidden />
                    </span>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto rounded-xl p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateTo}
                  onSelect={(date) => {
                    setDateTo(date);
                    setToOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            onClick={() => {
              setPage(0);
              setFilters({
                eventType: eventType.trim(),
                status: status.trim() === "all" ? "" : status.trim(),
                createdFrom: toIsoStartOfDay(dateFrom),
                createdTo: toIsoEndOfDay(dateTo),
              });
            }}
            disabled={loading}
          >
            {t("audit.applyFilter")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setEventType("");
              setStatus("all");
              setDateFrom(undefined);
              setDateTo(undefined);
              setFilters({ eventType: "", status: "", createdFrom: "", createdTo: "" });
              setPage(0);
            }}
            disabled={loading}
          >
            {t("audit.clearFilter")}
          </Button>
        </div>
      </section>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.95fr)]">
        <div className="min-w-0 self-start space-y-3">
          <section className="overflow-hidden rounded-lg border border-border/70 bg-background/80 shadow-sm">
            <div className={cn("transition-opacity duration-150", loading && rows.length > 0 && "opacity-75")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[160px] px-3.5 py-2.5">{t("audit.colTime")}</TableHead>
                  <TableHead className="px-3.5 py-2.5">{t("audit.colEventType")}</TableHead>
                  <TableHead className="px-3.5 py-2.5">{t("audit.colResource")}</TableHead>
                  <TableHead className="w-[96px] px-3.5 py-2.5">{t("audit.colStatus")}</TableHead>
                  <TableHead className="px-3.5 py-2.5">{t("audit.colMethodRoute")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      {loading ? t("common.loading") : t("audit.empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => {
                    const selected = selectedEvent?.id === row.id;
                    const resource = formatAuditResource(row);
                    const requestSummary = getRequestSummary(row);
                    return (
                      <TableRow
                        key={row.id}
                        className={cn(
                          "cursor-pointer align-top transition-colors",
                          selected && "bg-muted/60 hover:bg-muted/60",
                        )}
                        onClick={() => setSelectedEventId(row.id)}
                      >
                        <TableCell className="px-3.5 py-2.5 align-top">
                          <div className="text-sm font-medium leading-5 text-foreground">{formatTime(row.created_at)}</div>
                        </TableCell>
                        <TableCell className="px-3.5 py-2.5 align-top">
                          <div className="flex items-start gap-1.5">
                            <ChevronRight
                              className={cn(
                                "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
                                selected && "rotate-90 text-foreground",
                              )}
                              aria-hidden
                            />
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium leading-5 text-foreground" title={row.event_type}>
                                {row.event_type}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                                <span>{row.actor || "-"}</span>
                                {isProviderEvent(row) ? (
                                  <span className="rounded-full border border-border/80 px-1.5 py-0.5 leading-none">
                                    {row.payload?.provider || "provider"}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-3.5 py-2.5 align-top">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium leading-5 text-foreground" title={resource.primary}>
                              {resource.primary}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={resource.secondary}>
                              {resource.secondary}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-3.5 py-2.5 align-top">
                          <span
                            className={cn(
                              "inline-flex min-w-[34px] items-center justify-center rounded-full px-2.5 py-1 text-[11px] font-medium leading-none tracking-[0.01em]",
                              getStatusTone(row.status),
                            )}
                          >
                            {row.status || "-"}
                          </span>
                        </TableCell>
                        <TableCell className="px-3.5 py-2.5 align-top">
                          <div className="truncate text-sm leading-5 text-foreground" title={requestSummary}>
                            {requestSummary}
                          </div>
                          {row.payload?.http_status_code ? (
                            <div className="mt-0.5 text-[11px] text-muted-foreground">HTTP {row.payload.http_status_code}</div>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            </div>
          </section>

          <div className="overflow-x-auto rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
            <div className="flex min-w-max items-center justify-between gap-4 whitespace-nowrap">
              <div className="flex items-center gap-3">
                <div className="font-medium text-foreground/80">
                  {t("audit.pageInfo", { total: String(total) })}
                  {t("audit.pageNav", { cur: String(page + 1), all: String(totalPages) })}
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
                  <Switch
                    id="audit-auto-refresh"
                    checked={autoRefresh}
                    onCheckedChange={setAutoRefresh}
                  />
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
          </div>
        </div>

        <aside className="rounded-lg border border-border/70 bg-background/80 p-4 shadow-sm xl:sticky xl:top-4 xl:self-start">
          <div className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight">{t("audit.detailTitle")}</h2>
          </div>

          {!selectedEvent ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
              {t("audit.detailEmpty")}
            </div>
          ) : (
            <div className="space-y-4">
              <section className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3">
                <h3 className="text-sm font-semibold text-foreground">{t("audit.sectionBasic")}</h3>
                <DetailRow label={t("audit.colTime")} value={formatTime(selectedEvent.created_at)} />
                <DetailRow label={t("audit.colEventType")} value={selectedEvent.event_type} />
                <DetailRow label={t("audit.colActor")} value={selectedEvent.actor} />
                <DetailRow label={t("audit.colStatus")} value={selectedEvent.status} />
              </section>

              <section className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3">
                <h3 className="text-sm font-semibold text-foreground">{t("audit.sectionRequest")}</h3>
                <DetailRow label={t("audit.fieldMethod")} value={selectedEvent.method} />
                <DetailRow label={t("audit.fieldRoute")} value={selectedEvent.route} />
                <DetailRow label={t("audit.fieldResourceType")} value={selectedEvent.resource_type} />
                <DetailRow label={t("audit.fieldResourceId")} value={selectedEvent.resource_id} />
              </section>

              <section className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3">
                <h3 className="text-sm font-semibold text-foreground">{t("audit.sectionProvider")}</h3>
                <DetailRow label={t("audit.fieldProvider")} value={selectedEvent.payload?.provider} />
                <DetailRow label={t("audit.fieldModel")} value={selectedEvent.payload?.model} />
                <DetailRow label={t("audit.fieldEndpoint")} value={selectedEvent.payload?.endpoint} />
                <DetailRow label={t("audit.fieldFeature")} value={selectedEvent.payload?.feature} />
                <DetailRow label={t("audit.fieldStream")} value={selectedEvent.payload?.stream} />
                <DetailRow label={t("audit.fieldProjectId")} value={selectedEvent.payload?.project_id} />
              </section>

              <section className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3">
                <h3 className="text-sm font-semibold text-foreground">{t("audit.sectionResult")}</h3>
                <DetailRow label={t("audit.fieldHttpStatus")} value={selectedEvent.payload?.http_status_code} />
                <DetailRow label={t("audit.fieldLatency")} value={selectedEvent.payload?.latency_ms ? `${selectedEvent.payload.latency_ms} ms` : "-"} />
                <DetailRow label={t("audit.fieldOk")} value={selectedEvent.payload?.ok} />
                <DetailRow label={t("audit.fieldErrorType")} value={selectedEvent.payload?.error_type} />
                <DetailRow label={t("audit.fieldErrorMessage")} value={selectedEvent.payload?.error_message} />
              </section>
            </div>
          )}
        </aside>
      </div>

    </div>
  );
}
