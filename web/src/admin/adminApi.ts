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
