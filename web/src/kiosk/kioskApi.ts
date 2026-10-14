import type { Book, KioskUser, Loan } from "./kioskState";

type ApiResponse<T> = { data: T };
type OutboxAction = {
  id: string;
  kind: "borrow" | "return" | "renew" | "reserve";
  payload: Record<string, unknown>;
  createdAt: number;
};

const DB_NAME = "unmanned-library-kiosk";
const DB_VERSION = 1;
const OUTBOX_STORE = "outbox";
const CACHE_STORE = "cache";
const CACHE_KEYS = { books: "books", rules: "rules" } as const;

function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(body.message ?? body.error ?? body.code ?? "Request failed")) as Error & { code?: string };
    error.code = body.code ?? body.error;
    throw error;
  }
  return body as T;
}

function openDb(): Promise<IDBDatabase | null> {
  if (!("indexedDB" in window)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  if (!db) throw new Error("IndexedDB unavailable");
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = work(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function cachePut<T>(key: string, value: T) {
  try {
    await withStore(CACHE_STORE, "readwrite", (store) => store.put(value, key));
  } catch {
    localStorage.setItem(`ul-kiosk:${key}`, JSON.stringify(value));
  }
}

async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const value = await withStore<T | undefined>(CACHE_STORE, "readonly", (store) => store.get(key));
    if (value !== undefined) return value;
  } catch {
    // Fall back to localStorage for private browsing and test environments.
  }
  const raw = localStorage.getItem(`ul-kiosk:${key}`);
  return raw ? JSON.parse(raw) as T : undefined;
}

async function cachedLoanDays() {
  const rules = await cachedRules();
  const rule = rules.find((item) => item.key === "loan_days");
  return rule ? Number(JSON.parse(rule.value_json)) || 30 : 30;
}

async function addOutbox(action: OutboxAction) {
  try {
    await withStore(OUTBOX_STORE, "readwrite", (store) => store.put(action));
  } catch {
    const current = JSON.parse(localStorage.getItem("ul-kiosk:outbox") ?? "[]") as OutboxAction[];
    localStorage.setItem("ul-kiosk:outbox", JSON.stringify([...current, action]));
  }
}

async function allOutbox(): Promise<OutboxAction[]> {
  try {
    const indexed = await withStore<OutboxAction[]>(OUTBOX_STORE, "readonly", (store) => store.getAll());
    return indexed.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return (JSON.parse(localStorage.getItem("ul-kiosk:outbox") ?? "[]") as OutboxAction[]).sort((a, b) => a.createdAt - b.createdAt);
  }
}

async function removeOutbox(id: string) {
  try {
    await withStore(OUTBOX_STORE, "readwrite", (store) => store.delete(id));
  } catch {
    const remaining = (JSON.parse(localStorage.getItem("ul-kiosk:outbox") ?? "[]") as OutboxAction[]).filter((item) => item.id !== id);
    localStorage.setItem("ul-kiosk:outbox", JSON.stringify(remaining));
  }
}

export async function outboxCount() {
  return (await allOutbox()).length;
}

export async function loginCard(cardNumber: string) {
  const response = await request<{ user: KioskUser }>("/api/auth/card-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardNumber })
  });
  return response.user;
}

export async function loginPassword(cardNumber: string, password: string) {
  const response = await request<{ user: KioskUser }>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", account: cardNumber, password })
  });
  return response.user;
}

/** The reader already signed in on this browser (e.g. via /login), or null for no session or a staff session. */
export async function currentReader() {
  const { user } = await request<{ user: (Omit<KioskUser, "role"> & { role: string }) | null }>("/api/auth/me");
  return user?.role === "reader" ? user as KioskUser : null;
}

export async function logout() {
  await request("/api/auth/logout", { method: "POST" });
}

export async function getStats() {
  return request<{ branchesLive: number; devicesOnline: number; loansToday: number; branchNetwork: string }>("/api/public/stats");
}

export async function listBooks(query = "") {
  const params = new URLSearchParams({ limit: "50", branchId: "branch-east" });
  if (query.trim()) params.set("q", query.trim());
  const response = await request<ApiResponse<Book[]>>(`/api/books?${params.toString()}`);
  await cachePut(CACHE_KEYS.books, response.data);
  return response.data;
}

export async function cachedBooks() {
  return (await cacheGet<Book[]>(CACHE_KEYS.books)) ?? [];
}

export async function listLoans() {
  const response = await request<ApiResponse<Loan[]>>("/api/loans?limit=100");
  return response.data;
}

export async function getRules() {
  const response = await request<ApiResponse<Array<{ key: string; value_json: string }>>>("/api/rules");
  await cachePut(CACHE_KEYS.rules, response.data);
  return response.data;
}

export async function cachedRules() {
  return (await cacheGet<Array<{ key: string; value_json: string }>>(CACHE_KEYS.rules)) ?? [];
}

async function performOutbox(item: OutboxAction) {
  if (item.kind === "borrow") {
    return request("/api/loans/borrow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.payload) });
  }
  if (item.kind === "return") {
    return request(`/api/loans/${String(item.payload.loanId)}/return`, { method: "POST" });
  }
  if (item.kind === "renew") {
    return request(`/api/loans/${String(item.payload.loanId)}/renew`, { method: "POST" });
  }
  return request("/api/reservations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.payload) });
}

export async function syncOutbox(onConflict?: (message: string) => void) {
  const items = await allOutbox();
  let synced = 0;
  for (const item of items) {
    try {
      await performOutbox(item);
      await removeOutbox(item.id);
      synced += 1;
    } catch (error) {
      onConflict?.(error instanceof Error ? error.message : "同步冲突，需要重新确认");
      break;
    }
  }
  return { synced, remaining: await outboxCount() };
}

export async function borrowBook(input: { book: Book; userId: string; branchId: string; deviceId?: string; online: boolean }) {
  const loanDays = await cachedLoanDays();
  const offlineLoan = (id: string) => ({
    id: `offline-${id}`,
    book_id: input.book.id,
    due_at: new Date(Date.now() + loanDays * 86400000).toISOString()
  } as Loan);
  const payload = {
    bookId: input.book.id,
    userId: input.userId,
    branchId: input.branchId,
    deviceId: input.deviceId,
    idempotencyKey: idempotencyKey("kiosk-borrow")
  };
  if (input.online) {
    try {
      return { online: true, data: (await request<ApiResponse<Loan>>("/api/loans/borrow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).data };
    } catch (error) {
      if (error instanceof TypeError || !(error as Error & { code?: string }).code) {
        await addOutbox({ id: payload.idempotencyKey, kind: "borrow", payload, createdAt: Date.now() });
        return { online: false, data: offlineLoan(payload.idempotencyKey) };
      }
      throw error;
    }
  }
  await addOutbox({ id: payload.idempotencyKey, kind: "borrow", payload, createdAt: Date.now() });
  return { online: false, data: offlineLoan(payload.idempotencyKey) };
}

export async function returnBook(input: { loan: Loan; online: boolean }) {
  const payload = { loanId: input.loan.id };
  if (input.online && !input.loan.id.startsWith("offline-")) {
    try {
      return { online: true, data: (await request<ApiResponse<Loan>>(`/api/loans/${input.loan.id}/return`, { method: "POST" })).data };
    } catch (error) {
      if (!(error instanceof TypeError) && (error as Error & { code?: string }).code) throw error;
    }
  }
  await addOutbox({ id: idempotencyKey("kiosk-return"), kind: "return", payload, createdAt: Date.now() });
  return { online: false, data: input.loan };
}

export async function renewLoan(input: { loan: Loan; online: boolean }) {
  const payload = { loanId: input.loan.id };
  if (input.online && !input.loan.id.startsWith("offline-")) {
    try {
      return { online: true, data: (await request<ApiResponse<Loan>>(`/api/loans/${input.loan.id}/renew`, { method: "POST" })).data };
    } catch (error) {
      if (!(error instanceof TypeError) && (error as Error & { code?: string }).code) throw error;
    }
  }
  await addOutbox({ id: idempotencyKey("kiosk-renew"), kind: "renew", payload, createdAt: Date.now() });
  return { online: false, data: input.loan };
}

export async function reserveBook(input: { book: Book; userId: string; online: boolean }) {
  const payload = { bookId: input.book.id, userId: input.userId };
  if (input.online) {
    try {
      return { online: true, data: (await request<ApiResponse<Record<string, unknown>>>("/api/reservations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).data };
    } catch (error) {
      if (!(error instanceof TypeError) && (error as Error & { code?: string }).code) throw error;
    }
  }
  await addOutbox({ id: idempotencyKey("kiosk-reserve"), kind: "reserve", payload, createdAt: Date.now() });
  return { online: false, data: payload };
}

export async function requestHelp(branchId: string, message: string) {
  return request<ApiResponse<Record<string, unknown>>>("/api/help", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branchId, message })
  });
}
