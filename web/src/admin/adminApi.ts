/*
 * Admin data layer. Talks to the endpoints in docs/API.md; anything the backend does not
 * serve yet (see docs/API_REQUESTS.md) falls back to a local mock handler, but only when
 * the route itself is missing (404 without an error code), never to hide a real error.
 */

export type Role = "reader" | "librarian" | "admin";
export type SessionUser = { id: string; role: Role; name: string; account: string };
export type Branch = { id: string; code: string; name_zh: string; name_en: string; status?: string };
export type Overview = { branches: number; books: number; readers: number; devicesOnline: number; activeLoans: number; openAlerts: number };

export type BookRow = {
  id: string;
  isbn: string;
  title: string;
  author: string;
  category: string;
  branch_id: string;
  shelf_location: string;
  edition: string;
  purchased_at: string;
  rfid_tag: string;
  status: "on_shelf" | "borrowed" | "lost" | "repair";
  cover_color: string;
  call_number?: string;
};

export type ReaderRow = {
  id: string;
  role: Role;
  username: string;
  email?: string | null;
  display_name: string;
  student_no?: string | null;
  card_no?: string | null;
  deposit_cents: number;
  status: string;
  locked_until?: string | null;
  created_at: string;
};

export type LoanRow = {
  id: string;
  book_id: string;
  user_id: string;
  branch_id: string;
  borrowed_at: string;
  due_at: string;
  returned_at?: string | null;
  renew_count: number;
  status: "active" | "returned" | "overdue" | "lost";
};

export type AlertRow = { id: string; branch_id: string; type: string; severity: "info" | "warning" | "critical"; message: string; status: string; created_at: string };
export type RuleRow = { key: string; value_json: string; description: string; updated_at?: string };
export type HistoryEvent = { at: string; kind: "acquired" | "borrowed" | "renewed" | "returned" | "overdue" | "lost"; loanId?: string; userId?: string };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }

  /** The route does not exist on this server (as opposed to a domain "not found"). */
  get routeMissing() {
    return this.status === 404 && this.code === "ROUTE_MISSING";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
  const body = (await response.json().catch(() => ({}))) as { code?: string; error?: string; message?: string };
  if (!response.ok) {
    const code = body.code ?? body.error ?? (response.status === 404 ? "ROUTE_MISSING" : `HTTP_${response.status}`);
    throw new ApiError(response.status, code, body.message);
  }
  return body as T;
}

/** Calls the real endpoint; if the route is missing on the server, answers with the mock instead. */
export async function withMock<T>(real: () => Promise<T>, mock: () => Promise<T>): Promise<T> {
  try {
    return await real();
  } catch (error) {
    if (error instanceof ApiError && error.routeMissing) return mock();
    throw error;
  }
}

export type PageQuery = { page: number; pageSize: number; status?: string; q?: string; branchId?: string; userId?: string };
export type Page<T> = { rows: T[]; hasNext: boolean };

/**
 * Server-side pagination with limit/offset. The API has no total yet, so we ask for one
 * extra row to know whether a next page exists.
 */
export async function listPage<T>(path: string, query: PageQuery): Promise<Page<T>> {
  const params = new URLSearchParams({ limit: String(query.pageSize + 1), offset: String((query.page - 1) * query.pageSize) });
  for (const key of ["status", "q", "branchId", "userId"] as const) {
    const value = query[key];
    if (value && value !== "all") params.set(key, value);
  }
  const { data } = await api<{ data: T[] }>(`${path}?${params.toString()}`);
  return { rows: data.slice(0, query.pageSize), hasNext: data.length > query.pageSize };
}

export const fetchMe = () => api<{ user: SessionUser | null }>("/api/auth/me").then((body) => body.user);
export const fetchBranches = () => api<{ data: Branch[] }>("/api/branches").then((body) => body.data);
export const fetchOverview = () => api<{ data: Overview }>("/api/stats/overview").then((body) => body.data);
export const logout = () => api("/api/auth/logout", { method: "POST" }).catch(() => undefined);

export function fetchOpenAlerts(branchId: string) {
  const params = new URLSearchParams({ status: "open", limit: "200" });
  if (branchId !== "all") params.set("branchId", branchId);
  return api<{ data: AlertRow[] }>(`/api/alerts?${params.toString()}`).then((body) => body.data);
}

export const fetchRules = () => api<{ data: RuleRow[]; lastChanged: { ts?: string; actor_id?: string } | null }>("/api/rules");
export const saveRule = (key: string, value: unknown, description: string) =>
  api<{ data: RuleRow }>(`/api/rules/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value, description }) });

/* ---------- Cached lookups (loans only carry ids) ---------- */

const bookCache = new Map<string, Promise<BookRow | null>>();
const readerCache = new Map<string, Promise<ReaderRow | null>>();

export function getBook(id: string) {
  if (!bookCache.has(id)) bookCache.set(id, api<{ data: BookRow }>(`/api/books/${encodeURIComponent(id)}`).then((body) => body.data).catch(() => null));
  return bookCache.get(id)!;
}

export function getReader(id: string) {
  if (!readerCache.has(id)) readerCache.set(id, api<{ data: ReaderRow }>(`/api/readers/${encodeURIComponent(id)}`).then((body) => body.data).catch(() => null));
  return readerCache.get(id)!;
}

/* ---------- Loan history ---------- */

export function loanEvents(loan: LoanRow, now = Date.now()): HistoryEvent[] {
  const events: HistoryEvent[] = [{ at: loan.borrowed_at, kind: "borrowed", loanId: loan.id, userId: loan.user_id }];
  if (loan.renew_count > 0) events.push({ at: loan.due_at, kind: "renewed", loanId: loan.id, userId: loan.user_id });
  if (loan.returned_at) events.push({ at: loan.returned_at, kind: "returned", loanId: loan.id, userId: loan.user_id });
  else if (loan.status === "lost") events.push({ at: loan.due_at, kind: "lost", loanId: loan.id, userId: loan.user_id });
  else if (loan.status === "overdue" || new Date(loan.due_at).getTime() < now) events.push({ at: loan.due_at, kind: "overdue", loanId: loan.id, userId: loan.user_id });
  return events;
}

function sortNewestFirst(events: HistoryEvent[]) {
  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/**
 * GET /api/books/:id/history is requested in docs/API_REQUESTS.md. Until it ships, the mock
 * rebuilds the history from the most recent loans the server does return.
 */
export function fetchBookHistory(book: BookRow): Promise<HistoryEvent[]> {
  return withMock(
    () => api<{ data: HistoryEvent[] }>(`/api/books/${encodeURIComponent(book.id)}/history`).then((body) => body.data),
    async () => {
      const { data } = await api<{ data: LoanRow[] }>("/api/loans?limit=200");
      const events = data.filter((loan) => loan.book_id === book.id).flatMap((loan) => loanEvents(loan));
      if (book.purchased_at) events.push({ at: book.purchased_at, kind: "acquired" });
      return sortNewestFirst(events);
    }
  );
}

export async function fetchReaderHistory(readerId: string): Promise<Array<HistoryEvent & { bookId: string }>> {
  const { data } = await api<{ data: LoanRow[] }>(`/api/loans?userId=${encodeURIComponent(readerId)}&limit=50`);
  return sortNewestFirst(data.flatMap((loan) => loanEvents(loan).map((event) => ({ ...event, bookId: loan.book_id })))) as Array<HistoryEvent & { bookId: string }>;
}

/* ---------- Devices ---------- */

export type DeviceStatus = "online" | "offline" | "fault";
export type DeviceRow = {
  id: string;
  branch_id: string;
  kind: "kiosk" | "rfid_reader" | "gate" | "camera" | "temp_humidity" | "light" | "smoke" | "pir" | "shelf";
  name: string;
  vendor: string;
  protocol: string;
  address: string;
  status: DeviceStatus;
  last_seen_at?: string | null;
  config_json: string;
};

export type DeviceTestResult = { command: string; ok: boolean; latencyMs: number | null; output: string; at: string; simulated?: boolean };

const deviceIndexCache = new Map<string, Promise<Map<string, DeviceRow>>>();

/** All devices of a branch (or all branches) keyed by id; there is no GET /api/devices/:id. */
export function fetchDeviceIndex(branchId: string, fresh = false) {
  if (fresh || !deviceIndexCache.has(branchId)) {
    const params = new URLSearchParams({ limit: "200" });
    if (branchId !== "all") params.set("branchId", branchId);
    const request = api<{ data: DeviceRow[] }>(`/api/devices?${params.toString()}`).then((body) => new Map(body.data.map((device) => [device.id, device])));
    request.catch(() => deviceIndexCache.delete(branchId));
    deviceIndexCache.set(branchId, request);
  }
  return deviceIndexCache.get(branchId)!;
}

export const updateDevice = (id: string, patch: Partial<DeviceRow>) =>
  api<{ data: DeviceRow }>(`/api/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }).then((body) => body.data);

export const DEVICE_COMMANDS: Record<string, string[]> = {
  default: ["ping", "self_test"],
  kiosk: ["ping", "self_test", "print_test"],
  gate: ["ping", "self_test", "open_gate"],
  camera: ["ping", "snapshot"],
  light: ["ping", "toggle"]
};

/**
 * POST /api/devices/:id/test is requested in docs/API_REQUESTS.md. The mock answers like a
 * device would: online devices reply with a latency, offline ones time out, faulty ones error.
 */
export function testDevice(device: DeviceRow, command: string): Promise<DeviceTestResult> {
  return withMock(
    () => api<{ data: DeviceTestResult }>(`/api/devices/${encodeURIComponent(device.id)}/test`, { method: "POST", body: JSON.stringify({ command }) }).then((body) => body.data),
    () => mockDeviceTest(device, command)
  );
}

export async function mockDeviceTest(device: DeviceRow, command: string, wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<DeviceTestResult> {
  const seed = [...device.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const latencyMs = 18 + (seed % 60);
  await wait(device.status === "online" ? latencyMs * 8 : 1200);
  const at = new Date().toISOString();
  if (device.status === "offline") return { command, ok: false, latencyMs: null, output: `${command}: timeout after 1200 ms (no heartbeat)`, at, simulated: true };
  if (device.status === "fault") return { command, ok: false, latencyMs, output: `${command}: device reported fault E-${(seed % 90) + 10}`, at, simulated: true };
  return { command, ok: true, latencyMs, output: `${command}: OK (${device.protocol}://${device.address}, ${latencyMs} ms)`, at, simulated: true };
}

/* ---------- Alerts ---------- */

export type AlertStatus = "open" | "acked" | "resolved";
export type AlertFull = AlertRow & {
  device_id?: string | null;
  status: AlertStatus;
  acked_by?: string | null;
  acked_at?: string | null;
  resolved_at?: string | null;
  related_loan_id?: string | null;
  related_clip_id?: string | null;
  updated_at?: string;
};

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const;

/** Most severe first, newest first within a severity. */
export function sortAlerts<A extends Pick<AlertFull, "severity" | "created_at">>(alerts: A[]) {
  return [...alerts].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || b.created_at.localeCompare(a.created_at));
}

export function fetchAlerts(status: AlertStatus, branchId: string) {
  const params = new URLSearchParams({ status, limit: "200" });
  if (branchId !== "all") params.set("branchId", branchId);
  return api<{ data: AlertFull[] }>(`/api/alerts?${params.toString()}`).then((body) => body.data);
}

export const ackAlert = (id: string) => api<{ data: AlertFull }>(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: "POST" }).then((body) => body.data);
export const resolveAlert = (id: string) => api<{ data: AlertFull }>(`/api/alerts/${encodeURIComponent(id)}/resolve`, { method: "POST" }).then((body) => body.data);

export type AlertTimelineEvent = { at: string; kind: "raised" | "acked" | "maintenance" | "resolved"; detail?: string; approximate?: boolean };

/** Builds an alert's history from its own fields and the maintenance records that reference it. */
export function alertTimeline(alert: AlertFull, maintenance: MaintenanceRow[]): AlertTimelineEvent[] {
  const events: AlertTimelineEvent[] = [{ at: alert.created_at, kind: "raised", detail: alert.message }];
  if (alert.acked_at) events.push({ at: alert.acked_at, kind: "acked", detail: alert.acked_by ?? undefined });
  else if (alert.status === "acked" && alert.updated_at) events.push({ at: alert.updated_at, kind: "acked", detail: alert.acked_by ?? undefined, approximate: true });
  for (const record of maintenance.filter((item) => item.related_alert_id === alert.id)) events.push({ at: record.started_at, kind: "maintenance", detail: record.description });
  if (alert.resolved_at) events.push({ at: alert.resolved_at, kind: "resolved" });
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

/* ---------- Camera clips ---------- */

export type ClipRow = { id: string; device_id: string | null; branch_id: string; start_ts: string; end_ts: string; url: string | null; simulated?: boolean };

/** GET /api/clips/:id is requested; until then the player shows a simulated feed for the clip window. */
export function fetchClip(alert: AlertFull): Promise<ClipRow> {
  const id = alert.related_clip_id!;
  return withMock(
    () => api<{ data: ClipRow }>(`/api/clips/${encodeURIComponent(id)}`).then((body) => body.data),
    async () => {
      const at = new Date(alert.created_at).getTime();
      return { id, device_id: alert.device_id ?? null, branch_id: alert.branch_id, start_ts: new Date(at - 10_000).toISOString(), end_ts: new Date(at + 20_000).toISOString(), url: null, simulated: true };
    }
  );
}

/* ---------- Maintenance ---------- */

export type MaintenanceKind = "device_repair" | "inventory" | "book_mending" | "restock";
export type MaintenanceRow = {
  id: string;
  branch_id: string;
  device_id?: string | null;
  kind: MaintenanceKind;
  description: string;
  started_at: string;
  finished_at?: string | null;
  operator_id?: string | null;
  related_alert_id?: string | null;
  created_at?: string;
};
export type MaintenanceInput = Omit<MaintenanceRow, "id" | "created_at">;

export function fetchMaintenanceForAlert(alert: AlertFull) {
  return api<{ data: MaintenanceRow[] }>(`/api/maintenance?branchId=${encodeURIComponent(alert.branch_id)}&limit=200`).then((body) => body.data.filter((row) => row.related_alert_id === alert.id));
}

export const createMaintenance = (input: MaintenanceInput) =>
  api<{ data: MaintenanceRow }>("/api/maintenance", { method: "POST", body: JSON.stringify(input) }).then((body) => body.data);

/* ---------- Simulator ---------- */

export const SCENARIOS = ["smoke_spike", "device_offline", "illegal_exit", "sensor_glitch", "network_outage", "overload", "recover"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export type SimulatorStatus = { enabled: boolean; running: boolean; queued: number; scenarios: Record<string, { scenario: string; until: number }> };

export const fetchSimulator = () => api<{ data: SimulatorStatus }>("/api/simulator/status").then((body) => body.data);
export const setSimulator = (enabled: boolean) => api<{ data: SimulatorStatus }>("/api/simulator", { method: "POST", body: JSON.stringify({ enabled }) }).then((body) => body.data);
export const runScenario = (scenario: Scenario, branchId?: string) =>
  api<{ data: { scenario: string; branchId: string; queued: number } }>("/api/simulator/scenario", { method: "POST", body: JSON.stringify({ scenario, branchId }) }).then((body) => body.data);
