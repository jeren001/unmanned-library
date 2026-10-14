/*
 * Data layer for the Telemetry, Traceability and Exports pages. Each page reads one shape;
 * where the backend route is still a request in docs/API_REQUESTS.md (#10–#12), the shape is
 * assembled here from the endpoints that do exist, via withMock (only on a missing route).
 */

import {
  api, ApiError, fetchAlerts, fetchDeviceIndex, getBook, getReader, withMock,
  type AlertFull, type BookRow, type DeviceRow, type LoanRow, type MaintenanceRow, type ReaderRow, type RuleRow
} from "./adminApi";

/* ---------- Telemetry ---------- */

export type TelemetryQuality = "ok" | "suspect" | "dirty";
export type TelemetrySample = { id: string; device_id: string; branch_id: string; metric: string; value: number; quality: TelemetryQuality; ts: string };
export type TelemetryBucket = { ts: string; avg: number | null; min: number | null; max: number | null; count: number };
export type TelemetrySeries = {
  buckets: TelemetryBucket[];
  /** Samples not used in the aggregates (quality suspect or dirty). */
  flagged: TelemetrySample[];
  samples: number;
  /** Mock only: query windows that hit the server's 1000-row cap, so the series is partial. */
  truncatedWindows?: number;
  windows?: number;
};

export const METRICS = [
  { key: "temperature", unit: "°C", digits: 1 },
  { key: "humidity", unit: "%", digits: 0 },
  { key: "light_lux", unit: "lx", digits: 0 },
  { key: "smoke_ppm", unit: "ppm", digits: 2 },
  { key: "occupancy", unit: "", digits: 0 }
] as const;
export type MetricKey = (typeof METRICS)[number]["key"];

const HOUR = 3600_000;
export const RANGES = {
  "24h": { span: 24 * HOUR, bucket: HOUR / 2, windows: 24 },
  "7d": { span: 7 * 24 * HOUR, bucket: 3 * HOUR, windows: 28 },
  "30d": { span: 30 * 24 * HOUR, bucket: 12 * HOUR, windows: 30 }
} as const;
export type RangeKey = keyof typeof RANGES;

export type Threshold = { min?: number; max?: number };

export function parseThresholds(rules: RuleRow[]): Record<string, Threshold> {
  const row = rules.find((rule) => rule.key === "alert_thresholds");
  if (!row) return {};
  try {
    const value = JSON.parse(row.value_json) as Record<string, Threshold>;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Fixed-width buckets over [from, to); min/max/avg use "ok" samples only. */
export function bucketize(samples: TelemetrySample[], from: number, to: number, bucketMs: number): Pick<TelemetrySeries, "buckets" | "flagged"> {
  const count = Math.max(1, Math.ceil((to - from) / bucketMs));
  const sums = Array.from({ length: count }, () => ({ sum: 0, min: Infinity, max: -Infinity, n: 0 }));
  const flagged: TelemetrySample[] = [];
  for (const sample of samples) {
    const at = new Date(sample.ts).getTime();
    if (!(at >= from && at < to)) continue;
    if (sample.quality !== "ok" || !Number.isFinite(sample.value)) {
      flagged.push(sample);
      continue;
    }
    const slot = sums[Math.min(count - 1, Math.floor((at - from) / bucketMs))]!;
    slot.sum += sample.value;
    slot.n += 1;
    slot.min = Math.min(slot.min, sample.value);
    slot.max = Math.max(slot.max, sample.value);
  }
  return {
    buckets: sums.map((slot, index) => ({
      ts: new Date(from + index * bucketMs).toISOString(),
      avg: slot.n ? slot.sum / slot.n : null,
      min: slot.n ? slot.min : null,
      max: slot.n ? slot.max : null,
      count: slot.n
    })),
    flagged
  };
}

export type AxisDomain = { min: number; max: number };

/** y-domain from clean data and thresholds, so one 999999 reading cannot flatten the chart. */
export function axisDomain(series: TelemetrySeries, threshold: Threshold | undefined): AxisDomain {
  const values: number[] = [];
  for (const bucket of series.buckets) {
    if (bucket.min !== null) values.push(bucket.min);
    if (bucket.max !== null) values.push(bucket.max);
  }
  if (threshold?.min !== undefined) values.push(threshold.min);
  if (threshold?.max !== undefined) values.push(threshold.max);
  if (!values.length) return { min: 0, max: 1 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1;
  const lower = min >= 0 && min - pad < 0 ? 0 : min - pad;
  return { min: Number(lower.toFixed(2)), max: Number((max + pad).toFixed(2)) };
}

/** Flagged samples outside the domain are pinned to its edge (and say so in the tooltip). */
export function placeFlagged(sample: TelemetrySample, domain: AxisDomain) {
  if (!Number.isFinite(sample.value) || sample.value > domain.max) return { y: domain.max, off: "above" as const };
  if (sample.value < domain.min) return { y: domain.min, off: "below" as const };
  return { y: sample.value, off: null };
}

const TELEMETRY_CAP = 1000;

async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]!);
    }
  }));
  return results;
}

/**
 * GET /api/telemetry answers `{ data: { series, anomalies, … } }` (docs/API.md); with aggregate=raw, `series` holds at
 * most 1000 rows, oldest first, so one query over a busy range would only show its beginning. The range is split into
 * windows queried in parallel.
 */
export async function fetchTelemetryRaw(branchId: string, metric: string, from: number, to: number, windows: number) {
  const step = (to - from) / windows;
  const bounds = Array.from({ length: windows }, (_, index) => [from + index * step, index === windows - 1 ? to : from + (index + 1) * step] as const);
  const pages = await pool(bounds, 6, ([start, end]) => {
    const params = new URLSearchParams({ branchId, metric, from: new Date(start).toISOString(), to: new Date(end).toISOString(), aggregate: "raw" });
    return api<{ data: { series: TelemetrySample[] } }>(`/api/telemetry?${params.toString()}`).then((body) => body.data.series);
  });
  const seen = new Set<string>();
  const samples: TelemetrySample[] = [];
  for (const page of pages) for (const sample of page) if (!seen.has(sample.id)) { seen.add(sample.id); samples.push(sample); }
  samples.sort((a, b) => a.ts.localeCompare(b.ts));
  return { samples, truncatedWindows: pages.filter((page) => page.length >= TELEMETRY_CAP).length, windows };
}

/** Requested as GET /api/telemetry/series (API_REQUESTS #10); the mock buckets raw samples. */
export function fetchTelemetrySeries(branchId: string, metric: string, range: RangeKey, now = Date.now()): Promise<TelemetrySeries> {
  const spec = RANGES[range];
  const to = now;
  const from = to - spec.span;
  return withMock(
    () => {
      const params = new URLSearchParams({ branchId, metric, from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket: String(spec.bucket / 1000) });
      return api<{ data: TelemetrySeries }>(`/api/telemetry/series?${params.toString()}`).then((body) => body.data);
    },
    async () => {
      const raw = await fetchTelemetryRaw(branchId, metric, from, to, spec.windows);
      return { ...bucketize(raw.samples, from, to, spec.bucket), samples: raw.samples.length, truncatedWindows: raw.truncatedWindows, windows: raw.windows };
    }
  );
}

/* ---------- Loans scan (the API cannot filter loans by id or book) ---------- */

const SCAN_PAGE = 200;
const SCAN_MAX_PAGES = 25;
let loanScan: { at: number; promise: Promise<LoanRow[]> } | null = null;

export type TraceLoan = LoanRow & { device_id?: string | null };

/** Every loan the server returns (newest first), cached for a minute. */
export function scanLoans(fresh = false): Promise<TraceLoan[]> {
  if (fresh || !loanScan || Date.now() - loanScan.at > 60_000) {
    const promise = scanAll<TraceLoan>("/api/loans");
    promise.catch(() => { loanScan = null; });
    loanScan = { at: Date.now(), promise };
  }
  return loanScan.promise;
}

/** Pages through a list endpoint (limit 200) until it runs out or hits the page cap. */
export async function scanAll<T>(path: string, params: Record<string, string> = {}, maxPages = SCAN_MAX_PAGES, onProgress?: (rows: number) => void) {
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ ...params, limit: String(SCAN_PAGE), offset: String(page * SCAN_PAGE) });
    const { data } = await api<{ data: T[] }>(`${path}?${query.toString()}`);
    rows.push(...data);
    onProgress?.(rows.length);
    if (data.length < SCAN_PAGE) return rows;
  }
  return rows;
}

/* ---------- Traceability ---------- */

export type TraceDeviceEvent = {
  at: string;
  kind: "borrow" | "renew" | "return" | "overdue" | "lost" | "maintenance" | "gate_in" | "gate_out";
  deviceId?: string | null;
  detail?: string;
  /** Derived from loan fields rather than a recorded device event. */
  derived?: boolean;
  approximate?: boolean;
};

export type TraceChain = {
  book: BookRow;
  loans: TraceLoan[];
  loan: TraceLoan | null;
  reader: ReaderRow | null;
  device: DeviceRow | null;
  deviceEvents: TraceDeviceEvent[];
  /** Alerts linked to the loan, then alerts on the loan's device (or clip, or branch) during the loan. */
  alerts: Array<AlertFull & { link: TraceAlertLink }>;
  /** Camera clips covering the loan window (from GET /api/trace). */
  clips?: TraceClip[];
  /** Maintenance opened for the chain's alerts (from GET /api/trace). */
  maintenance?: TraceMaintenance[];
  simulated?: boolean;
};

export type TraceAlertLink = "loan" | "device" | "clip" | "window";
export type TraceClip = { id: string; device_id: string | null; device_name?: string | null; branch_id: string; start_ts: string; end_ts: string; file_path?: string | null };
export type TraceMaintenance = MaintenanceRow & { device_name?: string | null; status?: "open" | "completed" };

/** One step of GET /api/trace (docs/API.md). */
export type ServerTraceStep = {
  order: number;
  kind: "book" | "rfid_tag" | "loan_transaction" | "device_event" | "camera_clip" | "alert" | "maintenance";
  ts: string;
  record: Record<string, unknown>;
};

export function loanWindow(loan: TraceLoan, now = Date.now()) {
  const start = new Date(loan.borrowed_at).getTime();
  const end = loan.returned_at ? new Date(loan.returned_at).getTime() : now;
  return [start, end] as const;
}

/** Device-side story of a loan, built from the loan row and maintenance on its device. */
export function deviceEventsFor(loan: TraceLoan, maintenance: MaintenanceRow[], now = Date.now()): TraceDeviceEvent[] {
  const events: TraceDeviceEvent[] = [{ at: loan.borrowed_at, kind: "borrow", deviceId: loan.device_id, derived: true }];
  if (loan.renew_count > 0) events.push({ at: loan.due_at, kind: "renew", deviceId: null, detail: `×${loan.renew_count}`, derived: true, approximate: true });
  if (loan.returned_at) events.push({ at: loan.returned_at, kind: "return", deviceId: null, derived: true });
  else if (loan.status === "lost") events.push({ at: loan.due_at, kind: "lost", derived: true });
  else if (loan.status === "overdue" || new Date(loan.due_at).getTime() < now) events.push({ at: loan.due_at, kind: "overdue", derived: true });
  const [start, end] = loanWindow(loan, now);
  for (const record of maintenance) {
    const at = new Date(record.started_at).getTime();
    if (record.device_id && record.device_id === loan.device_id && at >= start && at <= end) {
      events.push({ at: record.started_at, kind: "maintenance", deviceId: record.device_id, detail: record.description });
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

export function alertsFor(loan: TraceLoan, alerts: AlertFull[], now = Date.now()): TraceChain["alerts"] {
  const [start, end] = loanWindow(loan, now);
  const linked = alerts.filter((alert) => alert.related_loan_id === loan.id).map((alert) => ({ ...alert, link: "loan" as const }));
  const onDevice = alerts
    .filter((alert) => alert.related_loan_id !== loan.id && loan.device_id && alert.device_id === loan.device_id)
    .filter((alert) => { const at = new Date(alert.created_at).getTime(); return at >= start && at <= end; })
    .map((alert) => ({ ...alert, link: "device" as const }));
  return [...linked, ...onDevice.sort((a, b) => a.created_at.localeCompare(b.created_at))];
}

/**
 * Maps the server's flat chain onto the page's shape. Reader, device and the book's other loans
 * are looked up separately; device events are the loan's derived events plus recorded gate passes.
 */
export function fromServerTrace(steps: ServerTraceStep[], now = Date.now()) {
  const of = (kind: ServerTraceStep["kind"]) => steps.filter((step) => step.kind === kind).map((step) => step.record);
  const book = of("book")[0] as unknown as BookRow | undefined;
  if (!book) throw new Error("Trace response has no book step");
  const loan = (of("loan_transaction")[0] as unknown as TraceLoan | undefined) ?? null;
  const clips = of("camera_clip") as unknown as TraceClip[];
  const maintenance = of("maintenance") as unknown as TraceMaintenance[];
  const gates: TraceDeviceEvent[] = of("device_event")
    .filter((event) => event.source !== "loan")
    .map((event) => ({ at: String(event.ts), kind: event.direction === "in" ? "gate_in" as const : "gate_out" as const, deviceId: (event.device_id as string | null) ?? null, detail: (event.device_name as string | undefined) ?? undefined }));
  const clipIds = new Set(clips.map((clip) => clip.id));
  const alerts = (of("alert") as unknown as AlertFull[]).map((alert) => ({
    ...alert,
    link: (loan && alert.related_loan_id === loan.id ? "loan"
      : alert.related_clip_id && clipIds.has(alert.related_clip_id) ? "clip"
        : loan?.device_id && alert.device_id === loan.device_id ? "device"
          : "window") as TraceAlertLink
  }));
  const deviceEvents = loan ? [...deviceEventsFor(loan, [], now), ...gates].sort((a, b) => a.at.localeCompare(b.at)) : gates;
  return { book, loan, clips, maintenance, alerts, deviceEvents };
}

export const searchBooks = (q: string) =>
  api<{ data: BookRow[] }>(`/api/books?${new URLSearchParams({ q, limit: "12" }).toString()}`).then((body) => body.data);

export async function findLoan(id: string) {
  const loans = await scanLoans();
  return loans.find((loan) => loan.id.toLowerCase() === id.trim().toLowerCase()) ?? null;
}

/**
 * GET /api/trace?book=…|loanId=… (docs/API.md). A domain "not found" becomes TraceNotFound so the page
 * shows an empty state. On a server without the route, the mock joins books, loans, readers, devices,
 * maintenance and alerts; device events are derived from the loan.
 */
export function fetchTrace(bookId: string, loanId?: string | null): Promise<TraceChain> {
  return withMock<TraceChain>(
    async () => {
      // The server takes exactly one of book (id, ISBN, RFID tag or title), loanId or alertId.
      const params = new URLSearchParams(loanId ? { loanId } : { book: bookId });
      let steps: ServerTraceStep[];
      try {
        steps = (await api<{ data: { chain: ServerTraceStep[] } }>(`/api/trace?${params.toString()}`)).data.chain;
      } catch (error) {
        if (error instanceof ApiError && error.code === "TRACE_NOT_FOUND") throw new TraceNotFound(loanId ? "loan" : "book", loanId ?? bookId);
        throw error;
      }
      const trace = fromServerTrace(steps);
      const { book, loan } = trace;
      const [loans, reader, devices] = await Promise.all([
        scanLoans()
          .then((all) => all.filter((item) => item.book_id === book.id).sort((a, b) => b.borrowed_at.localeCompare(a.borrowed_at)))
          .catch(() => [] as TraceLoan[]),
        loan ? getReader(loan.user_id) : Promise.resolve(null),
        loan?.device_id ? fetchDeviceIndex("all").catch(() => new Map<string, DeviceRow>()) : Promise.resolve(new Map<string, DeviceRow>())
      ]);
      return {
        ...trace,
        loans: loan && !loans.some((item) => item.id === loan.id) ? [loan, ...loans] : loans,
        reader,
        device: loan?.device_id ? devices.get(loan.device_id) ?? null : null
      };
    },
    async () => {
      const [book, allLoans] = await Promise.all([getBook(bookId), scanLoans()]);
      if (!book) throw new TraceNotFound("book", bookId);
      const loans = allLoans.filter((loan) => loan.book_id === book.id).sort((a, b) => b.borrowed_at.localeCompare(a.borrowed_at));
      const loan = (loanId ? loans.find((item) => item.id === loanId) : loans[0]) ?? null;
      if (!loan) return { book, loans, loan: null, reader: null, device: null, deviceEvents: [], alerts: [], simulated: true };
      const [reader, devices, maintenance, alerts] = await Promise.all([
        getReader(loan.user_id),
        fetchDeviceIndex("all").catch(() => new Map<string, DeviceRow>()),
        api<{ data: MaintenanceRow[] }>(`/api/maintenance?branchId=${encodeURIComponent(loan.branch_id)}&limit=200`).then((body) => body.data),
        Promise.all((["open", "acked", "resolved"] as const).map((status) => fetchAlerts(status, loan.branch_id))).then((lists) => lists.flat())
      ]);
      return {
        book,
        loans,
        loan,
        reader,
        device: loan.device_id ? devices.get(loan.device_id) ?? null : null,
        deviceEvents: deviceEventsFor(loan, maintenance),
        alerts: alertsFor(loan, alerts),
        simulated: true
      };
    }
  );
}

export class TraceNotFound extends Error {
  constructor(public kind: "book" | "loan", public id: string) {
    super(`${kind} ${id} not found`);
  }
}

/* ---------- Exports ---------- */

export type DatasetKey = "loans" | "books" | "readers" | "alerts" | "maintenance" | "devices" | "telemetry";
export type ColumnSpec = { key: string; width?: number; number?: boolean };
export type DatasetSpec = { key: DatasetKey; path: string; dateField?: string; branchFilter: boolean; columns: ColumnSpec[] };

export const DATASETS: DatasetSpec[] = [
  { key: "loans", path: "/api/loans", dateField: "borrowed_at", branchFilter: true, columns: [
    { key: "id" }, { key: "book_id" }, { key: "user_id" }, { key: "branch_id" }, { key: "device_id" },
    { key: "borrowed_at" }, { key: "due_at" }, { key: "returned_at" }, { key: "renew_count", number: true }, { key: "status" }
  ] },
  { key: "books", path: "/api/books", dateField: "purchased_at", branchFilter: true, columns: [
    { key: "id" }, { key: "isbn" }, { key: "title", width: 36 }, { key: "author", width: 22 }, { key: "category" }, { key: "branch_id" },
    { key: "shelf_location" }, { key: "rfid_tag" }, { key: "status" }, { key: "purchased_at" }
  ] },
  { key: "readers", path: "/api/readers", dateField: "created_at", branchFilter: false, columns: [
    { key: "id" }, { key: "display_name", width: 20 }, { key: "username" }, { key: "card_no" }, { key: "student_no" },
    { key: "deposit_cents", number: true }, { key: "status" }, { key: "created_at" }
  ] },
  { key: "alerts", path: "/api/alerts", dateField: "created_at", branchFilter: true, columns: [
    { key: "id" }, { key: "created_at" }, { key: "branch_id" }, { key: "device_id" }, { key: "type" }, { key: "severity" },
    { key: "status" }, { key: "message", width: 40 }, { key: "related_loan_id" }, { key: "related_clip_id" }, { key: "resolved_at" }
  ] },
  { key: "maintenance", path: "/api/maintenance", dateField: "started_at", branchFilter: true, columns: [
    { key: "id" }, { key: "started_at" }, { key: "finished_at" }, { key: "branch_id" }, { key: "device_id" }, { key: "kind" },
    { key: "description", width: 40 }, { key: "operator_id" }, { key: "related_alert_id" }
  ] },
  { key: "devices", path: "/api/devices", branchFilter: true, columns: [
    { key: "id" }, { key: "name", width: 24 }, { key: "kind" }, { key: "branch_id" }, { key: "vendor" }, { key: "protocol" },
    { key: "address" }, { key: "status" }, { key: "last_seen_at" }
  ] },
  { key: "telemetry", path: "/api/telemetry", dateField: "ts", branchFilter: true, columns: [
    { key: "id" }, { key: "ts" }, { key: "branch_id" }, { key: "device_id" }, { key: "metric" }, { key: "value", number: true }, { key: "quality" }
  ] }
];

export type ExportQuery = { dataset: DatasetKey; branchId: string; from: string | null; to: string | null; metric?: string };
export type ExportResult = { rows: Array<Record<string, unknown>>; capped: boolean; scanned: number };

/** Max rows per export (and per scan); larger datasets need the server export (API_REQUESTS #12). */
export const EXPORT_ROW_CAP = 10_000;

/** Inclusive day range on an ISO timestamp; `from`/`to` are YYYY-MM-DD in local time. */
export function inRange(value: unknown, from: string | null, to: string | null) {
  if (!from && !to) return true;
  if (typeof value !== "string" || !value) return false;
  const at = new Date(value).getTime();
  if (from && at < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && at >= new Date(`${to}T00:00:00`).getTime() + 24 * HOUR) return false;
  return true;
}

export async function collectExport(query: ExportQuery, branches: string[], onProgress?: (rows: number) => void): Promise<ExportResult> {
  const spec = DATASETS.find((item) => item.key === query.dataset)!;
  if (spec.key === "telemetry") {
    const to = query.to ? new Date(`${query.to}T00:00:00`).getTime() + 24 * HOUR : Date.now();
    const from = query.from ? new Date(`${query.from}T00:00:00`).getTime() : to - 30 * 24 * HOUR;
    const days = Math.max(1, Math.ceil((to - from) / (24 * HOUR)));
    const metrics = query.metric && query.metric !== "all" ? [query.metric] : METRICS.map((item) => item.key);
    const targets = query.branchId === "all" ? branches : [query.branchId];
    let rows: TelemetrySample[] = [];
    let capped = false;
    collect: for (const branch of targets) {
      for (const metric of metrics) {
        const raw = await fetchTelemetryRaw(branch, metric, from, to, Math.min(days, 120));
        if (raw.truncatedWindows) capped = true;
        rows.push(...raw.samples);
        onProgress?.(rows.length);
        if (rows.length >= EXPORT_ROW_CAP) { rows = rows.slice(0, EXPORT_ROW_CAP); capped = true; break collect; }
      }
    }
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return { rows: rows.map((row) => Object.fromEntries(spec.columns.map((column) => [column.key, row[column.key as keyof TelemetrySample] ?? null]))), capped, scanned: rows.length };
  }
  const params: Record<string, string> = {};
  if (spec.branchFilter && query.branchId !== "all") params.branchId = query.branchId;
  const maxPages = EXPORT_ROW_CAP / SCAN_PAGE;
  let all = await scanAll<Record<string, unknown>>(spec.path, params, maxPages, onProgress);
  const capped = all.length >= EXPORT_ROW_CAP;
  // The readers endpoint also returns staff accounts and credential fields (API_REQUESTS #5).
  if (spec.key === "readers") all = all.filter((row) => row.role === "reader");
  const rows = spec.dateField ? all.filter((row) => inRange(row[spec.dateField!], query.from, query.to)) : all;
  return { rows: rows.map((row) => Object.fromEntries(spec.columns.map((column) => [column.key, row[column.key] ?? null]))), capped, scanned: all.length };
}

/* ---------- Export history ---------- */

export type ExportRecord = ExportQuery & { id: string; at: string; by: string; rows: number; filename: string; local?: boolean };

const HISTORY_KEY = "ul-export-history";

function readLocalHistory(): ExportRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as ExportRecord[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** GET /api/exports is requested (API_REQUESTS #12); until then history lives in this browser. */
export function fetchExportHistory(): Promise<ExportRecord[]> {
  return withMock(
    () => api<{ data: ExportRecord[] }>("/api/exports?limit=50").then((body) => body.data),
    async () => readLocalHistory().map((record) => ({ ...record, local: true }))
  );
}

export function recordExport(record: Omit<ExportRecord, "id" | "local">): Promise<ExportRecord> {
  return withMock(
    () => api<{ data: ExportRecord }>("/api/exports", { method: "POST", body: JSON.stringify(record) }).then((body) => body.data),
    async () => {
      const saved: ExportRecord = { ...record, id: `exp-${Date.now().toString(36)}`, local: true };
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify([saved, ...readLocalHistory()].slice(0, 50)));
      } catch {
        // History is a convenience; the download itself already happened.
      }
      return saved;
    }
  );
}

export function exportFilename(query: ExportQuery, branchCode: string, now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
  const range = query.from || query.to ? `_${query.from ?? "start"}_${query.to ?? "today"}` : "";
  const metric = query.dataset === "telemetry" && query.metric && query.metric !== "all" ? `-${query.metric}` : "";
  return `ul_${query.dataset}${metric}_${branchCode}${range}_${stamp}.xlsx`;
}
