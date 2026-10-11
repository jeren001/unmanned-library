import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { createServer } from "./server.js";
import type { LibraryRepository } from "../persistence/repositories.js";

process.env.SIMULATOR_ENABLED = "false";

type Role = "anonymous" | "reader" | "librarian" | "admin";
type Access = "public" | "operate" | "manage" | "admin";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type RouteCase = { method: Method; path: string; access: Access; ok: number; body?: unknown; freshSession?: boolean; stream?: boolean };

const roles: Role[] = ["anonymous", "reader", "librarian", "admin"];
const allowed: Record<Access, Role[]> = {
  public: roles,
  operate: ["reader", "librarian", "admin"],
  manage: ["librarian", "admin"],
  admin: ["admin"]
};
const credentials = {
  reader: { role: "reader", account: "R-2048", password: "reader123" },
  librarian: { role: "librarian", account: "librarian", password: "librarian123" },
  admin: { role: "admin", account: "admin", password: "admin123" }
} as const;
const hashes = Object.fromEntries(Object.entries(credentials).map(([role, value]) => [role, bcrypt.hashSync(value.password, 4)]));
const now = new Date().toISOString();

function seed(repo: LibraryRepository) {
  repo.insert("branches", { id: "branch-east", code: "EAST", name_zh: "东馆", name_en: "East", type: "campus", address: "East", status: "active" });
  repo.insert("users", { id: "reader-001", role: "reader", username: "R-2048", email: "reader.demo@library.local", password_hash: hashes.reader, display_name: "林知秋", student_no: "20240001", id_number_masked: "3201********1024", card_no: "20240001", qr_code: "QR-20240001", status: "active" });
  repo.insert("users", { id: "reader-002", role: "reader", username: "R-2049", email: "other.reader@library.local", password_hash: hashes.reader, display_name: "Other", card_no: "20240002", status: "active" });
  repo.insert("users", { id: "librarian-001", role: "librarian", username: "librarian", email: "librarian@library.local", password_hash: hashes.librarian, display_name: "Librarian", status: "active" });
  repo.insert("users", { id: "admin-001", role: "admin", username: "admin", email: "admin@library.local", password_hash: hashes.admin, display_name: "Admin", status: "active" });
  const book = { isbn: "978-1", author: "Author", category: "I247", branch_id: "branch-east", shelf_location: "A-01", edition: "1", purchased_at: "2026-01-01", cover_color: "#1F4D3A" };
  repo.insert("books", { ...book, id: "book-1", title: "On shelf", rfid_tag: "RFID-1", status: "on_shelf" });
  repo.insert("books", { ...book, id: "book-2", title: "Borrowed", rfid_tag: "RFID-2", status: "borrowed" });
  repo.insert("devices", { id: "device-1", branch_id: "branch-east", kind: "kiosk", name: "Kiosk", vendor: "Mock", protocol: "mock", address: "mock://1", status: "online", last_seen_at: now, config_json: "{}" });
  repo.insert("loans", { id: "loan-1", book_id: "book-2", user_id: "reader-001", branch_id: "branch-east", device_id: "device-1", borrowed_at: now, due_at: new Date(Date.now() + 30 * 86400_000).toISOString(), status: "active", idempotency_key: "seed-loan-1" });
  repo.insert("alerts", { id: "alert-1", branch_id: "branch-east", device_id: "device-1", type: "smoke", severity: "critical", message: "Smoke", status: "open" });
  repo.insert("maintenance_records", { id: "maint-1", branch_id: "branch-east", device_id: "device-1", kind: "device_repair", description: "Fix kiosk", started_at: now });
  repo.insert("export_history", { id: "export-1", dataset: "books", locale: "en", row_count: 2, file_name: "books.xlsx", download_path: "/api/exports/export-1/download" });
  repo.insert("telemetry", { id: "tel-1", device_id: "device-1", branch_id: "branch-east", metric: "temperature", value: 22, quality: "ok", ts: now });
  repo.upsertRule("loan_days", 30, "Loan days");
  repo.upsertRule("max_loans", 8, "Max loans");
  repo.upsertRule("max_renewals", 2, "Max renewals");
}

type Harness = { base: string; server: Server; repo: LibraryRepository; close: () => Promise<void> };

async function startServer(): Promise<Harness> {
  const app = createServer(":memory:");
  const repo = app.locals.persistence.repo as LibraryRepository;
  seed(repo);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    server,
    repo,
    close: async () => {
      app.locals.telemetryPipeline.stop();
      await app.locals.simulator.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.locals.persistence.db.close();
    }
  };
}

async function login(base: string, role: Exclude<Role, "anonymous">) {
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials[role]) });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

async function call(base: string, method: Method, path: string, options: { cookie?: string; body?: unknown; raw?: string; stream?: boolean } = {}) {
  const controller = new AbortController();
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined || options.raw !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    signal: controller.signal
  });
  const status = response.status;
  let payload: unknown = null;
  if (options.stream && status === 200) controller.abort();
  else if ((response.headers.get("content-type") ?? "").includes("json")) payload = await response.json();
  else await response.arrayBuffer();
  return { status, payload };
}

const routes: RouteCase[] = [
  { method: "GET", path: "/api/health", access: "public", ok: 200 },
  { method: "GET", path: "/api/public/stats", access: "public", ok: 200 },
  { method: "POST", path: "/api/auth/login", access: "public", ok: 200, body: credentials.reader },
  { method: "POST", path: "/api/auth/card-login", access: "public", ok: 200, body: { cardNumber: "20240001" } },
  { method: "GET", path: "/api/auth/me", access: "public", ok: 200 },
  { method: "POST", path: "/api/auth/logout", access: "public", ok: 204, freshSession: true },
  { method: "GET", path: "/api/books", access: "operate", ok: 200 },
  { method: "POST", path: "/api/books", access: "manage", ok: 201, body: { isbn: "978-9", title: "New", author: "A", category: "I247", branch_id: "branch-east", shelf_location: "B-01", edition: "1", purchased_at: "2026-02-01", rfid_tag: "RFID-NEW", cover_color: "#123456" } },
  { method: "PATCH", path: "/api/books/:id", access: "manage", ok: 200, body: { shelf_location: "C-02" } },
  { method: "GET", path: "/api/books/:id", access: "operate", ok: 200 },
  { method: "GET", path: "/api/readers", access: "manage", ok: 200 },
  { method: "POST", path: "/api/readers", access: "manage", ok: 201, body: { username: "R-3000", display_name: "New Reader", email: "new.reader@library.local", card_no: "20243000" } },
  { method: "GET", path: "/api/readers/:id", access: "operate", ok: 200 },
  { method: "PATCH", path: "/api/readers/:id/status", access: "manage", ok: 200, body: { status: "suspended" } },
  { method: "GET", path: "/api/loans", access: "operate", ok: 200 },
  { method: "POST", path: "/api/loans/borrow", access: "operate", ok: 201, body: { bookId: "book-1", userId: "reader-001", idempotencyKey: "rbac-borrow" } },
  { method: "POST", path: "/api/loans/:id/return", access: "operate", ok: 200 },
  { method: "POST", path: "/api/loans/:id/renew", access: "operate", ok: 200 },
  { method: "POST", path: "/api/loans/:id/lost", access: "manage", ok: 200 },
  { method: "POST", path: "/api/loans/:id/reminder", access: "manage", ok: 201 },
  { method: "GET", path: "/api/reservations", access: "operate", ok: 200 },
  { method: "POST", path: "/api/reservations", access: "operate", ok: 201, body: { bookId: "book-2", userId: "reader-001" } },
  { method: "POST", path: "/api/help", access: "operate", ok: 201, body: {} },
  { method: "GET", path: "/api/trace?book=RFID-2", access: "manage", ok: 200 },
  { method: "GET", path: "/api/exports/preview?dataset=books", access: "manage", ok: 200 },
  { method: "GET", path: "/api/exports/history", access: "manage", ok: 200 },
  { method: "GET", path: "/api/exports/download?dataset=books", access: "manage", ok: 200 },
  { method: "GET", path: "/api/exports/:id/download", access: "manage", ok: 200 },
  { method: "GET", path: "/api/devices", access: "manage", ok: 200 },
  { method: "POST", path: "/api/devices", access: "admin", ok: 201, body: { kind: "light", protocol: "mock", address: "mock://9", branch_id: "branch-east", name: "Lamp", vendor: "Mock" } },
  { method: "PATCH", path: "/api/devices/:id/config", access: "admin", ok: 200, body: { samplingIntervalSeconds: 60, thresholds: {} } },
  { method: "POST", path: "/api/devices/:id/test-command", access: "admin", ok: 200, body: { command: "ping" } },
  { method: "POST", path: "/api/devices/:id/health-check", access: "admin", ok: 200 },
  { method: "GET", path: "/api/alerts", access: "manage", ok: 200 },
  { method: "POST", path: "/api/alerts", access: "manage", ok: 201, body: { branch_id: "branch-east", type: "threshold", severity: "warning", message: "Too warm" } },
  { method: "POST", path: "/api/alerts/bulk-ack", access: "manage", ok: 200, body: { ids: ["alert-1"] } },
  { method: "GET", path: "/api/alerts/:id", access: "manage", ok: 200 },
  { method: "POST", path: "/api/alerts/:id/ack", access: "manage", ok: 200, body: {} },
  { method: "POST", path: "/api/alerts/:id/resolve", access: "manage", ok: 200, body: {} },
  { method: "POST", path: "/api/alerts/:id/notes", access: "manage", ok: 201, body: { note: "Checked" } },
  { method: "GET", path: "/api/telemetry?branchId=branch-east&metric=temperature", access: "manage", ok: 200 },
  { method: "POST", path: "/api/telemetry", access: "manage", ok: 202, body: { deviceId: "device-1", branchId: "branch-east", metric: "temperature", value: 23 } },
  { method: "POST", path: "/api/telemetry/archive", access: "admin", ok: 200 },
  { method: "GET", path: "/api/maintenance/timeline", access: "manage", ok: 200 },
  { method: "GET", path: "/api/maintenance", access: "manage", ok: 200 },
  { method: "POST", path: "/api/maintenance", access: "manage", ok: 201, body: { branch_id: "branch-east", kind: "inventory", description: "Count shelf", started_at: now } },
  { method: "PATCH", path: "/api/maintenance/:id", access: "manage", ok: 200, body: { description: "Fix kiosk screen" } },
  { method: "POST", path: "/api/maintenance/:id/complete", access: "manage", ok: 200, body: {} },
  { method: "GET", path: "/api/rules", access: "operate", ok: 200 },
  { method: "PUT", path: "/api/rules/:key", access: "manage", ok: 200, body: { value: 45, description: "Loan days" } },
  { method: "GET", path: "/api/branches", access: "operate", ok: 200 },
  { method: "GET", path: "/api/stats/overview", access: "manage", ok: 200 },
  { method: "GET", path: "/api/stream", access: "manage", ok: 200, stream: true },
  { method: "GET", path: "/api/simulator/status", access: "admin", ok: 200 },
  { method: "POST", path: "/api/simulator/start", access: "admin", ok: 200, body: {} },
  { method: "POST", path: "/api/simulator/stop", access: "admin", ok: 200 },
  { method: "PATCH", path: "/api/simulator/speed", access: "admin", ok: 200, body: { speed: 2 } },
  { method: "POST", path: "/api/simulator", access: "admin", ok: 200, body: { enabled: true } },
  { method: "POST", path: "/api/simulator/scenario", access: "admin", ok: 202, body: { scenario: "recover", branchId: "branch-east" } }
];

const params: Record<string, string> = {
  "/api/books/:id": "book-1",
  "/api/readers/:id": "reader-001",
  "/api/loans/:id": "loan-1",
  "/api/exports/:id": "export-1",
  "/api/devices/:id": "device-1",
  "/api/alerts/:id": "alert-1",
  "/api/maintenance/:id": "maint-1",
  "/api/rules/:key": "loan_days"
};
const resolvePath = (path: string) => Object.entries(params).reduce((result, [pattern, value]) => result.replace(pattern, pattern.replace(/:\w+$/, value)), path);

// Every route registered in /server/src/api, with its mount prefix, so a new route cannot skip the matrix.
function registeredRoutes() {
  const files: Record<string, string> = { "auth.ts": "/api/auth", "health.ts": "/api/health", "public.ts": "/api/public", "library.ts": "/api", "server.ts": "" };
  const found = new Set<string>();
  for (const [file, prefix] of Object.entries(files)) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\b\w*(?:[rR]outer|app)\.(get|post|put|patch|delete)\("([^"]+)"/g)) {
      const path = `${prefix}${match[2] === "/" ? "" : match[2]}`;
      found.add(`${match[1]!.toUpperCase()} ${path}`);
    }
  }
  return found;
}

let cookies: Record<Exclude<Role, "anonymous">, string>;

beforeAll(async () => {
  const harness = await startServer();
  cookies = {
    reader: await login(harness.base, "reader"),
    librarian: await login(harness.base, "librarian"),
    admin: await login(harness.base, "admin")
  };
  await harness.close();
});

describe("RBAC matrix", () => {
  it("covers every registered route", () => {
    const covered = new Set(routes.map((route) => `${route.method} ${route.path.split("?")[0]}`));
    expect([...registeredRoutes()].sort()).toEqual([...covered].sort());
  });

  for (const route of routes) {
    for (const role of roles) {
      const expected = allowed[route.access].includes(role) ? route.ok : role === "anonymous" ? 401 : 403;
      it(`${route.method} ${route.path} as ${role} -> ${expected}`, async () => {
        const harness = await startServer();
        try {
          let cookie = role === "anonymous" ? undefined : cookies[role];
          if (route.freshSession && role !== "anonymous") cookie = await login(harness.base, role);
          const { status } = await call(harness.base, route.method, resolvePath(route.path), { cookie, body: route.body, stream: route.stream });
          expect(status).toBe(expected);
        } finally {
          await harness.close();
        }
      });
    }
  }

  it("keeps readers inside their own records", async () => {
    const harness = await startServer();
    try {
      expect((await call(harness.base, "GET", "/api/readers/reader-002", { cookie: cookies.reader })).status).toBe(403);
      expect((await call(harness.base, "POST", "/api/loans/borrow", { cookie: cookies.reader, body: { bookId: "book-1", userId: "reader-002", idempotencyKey: "other" } })).status).toBe(403);
      expect((await call(harness.base, "POST", "/api/reservations", { cookie: cookies.reader, body: { bookId: "book-2", userId: "reader-002" } })).status).toBe(403);
    } finally {
      await harness.close();
    }
  });
});

describe("login rate limiting", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await startServer(); });
  afterAll(async () => { await harness.close(); });

  it("limits repeated attempts on one account", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 13; i += 1) statuses.push((await call(harness.base, "POST", "/api/auth/login", { body: { role: "librarian", account: "nobody", password: "x" } })).status);
    expect(statuses.slice(0, 12).every((status) => status === 401)).toBe(true);
    expect(statuses[12]).toBe(429);
  });

  it("limits one IP that rotates card numbers", async () => {
    const fresh = await startServer();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i += 1) statuses.push((await call(fresh.base, "POST", "/api/auth/card-login", { body: { cardNumber: `9900${String(i).padStart(4, "0")}` } })).status);
      expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
      expect(statuses[30]).toBe(429);
      expect((await call(fresh.base, "POST", "/api/auth/login", { body: credentials.reader })).status).toBe(429);
    } finally {
      await fresh.close();
    }
  });
});

describe("input validation", () => {
  const invalid: Array<[Method, string, unknown]> = [
    ["POST", "/api/auth/login", { role: "root", account: "", password: "" }],
    ["POST", "/api/auth/card-login", { cardNumber: "" }],
    ["POST", "/api/books", { title: "" }],
    ["PATCH", "/api/books/book-1", { unknown_field: "x" }],
    ["PATCH", "/api/books/book-1", { purchased_at: "not a date" }],
    ["POST", "/api/readers", { username: "", display_name: "x", status: "deleted" }],
    ["PATCH", "/api/readers/reader-001/status", { status: "banned" }],
    ["POST", "/api/loans/borrow", { bookId: "", userId: "reader-001", idempotencyKey: "k" }],
    ["POST", "/api/reservations", { bookId: 1 }],
    ["POST", "/api/help", { message: "x".repeat(501) }],
    ["POST", "/api/devices", { kind: "toaster", protocol: "mock" }],
    ["PATCH", "/api/devices/device-1/config", { samplingIntervalSeconds: 0, thresholds: {} }],
    ["POST", "/api/devices/device-1/test-command", { command: "" }],
    ["POST", "/api/alerts", { branch_id: "branch-east", type: "smoke", severity: "doom", message: "x" }],
    ["POST", "/api/alerts/bulk-ack", { ids: [] }],
    ["POST", "/api/alerts/alert-1/ack", { note: "" }],
    ["POST", "/api/alerts/alert-1/resolve", { note: 5 }],
    ["POST", "/api/alerts/alert-1/notes", {}],
    ["POST", "/api/telemetry", { deviceId: "device-1", branchId: "branch-east", metric: "temperature", value: "hot" }],
    ["POST", "/api/maintenance", { branch_id: "branch-east", kind: "inventory", description: "x", started_at: "yesterday-ish" }],
    ["PATCH", "/api/maintenance/maint-1", { kind: "magic" }],
    ["POST", "/api/maintenance/maint-1/complete", { finished_at: "soon" }],
    ["PUT", "/api/rules/loan_days", { value: "forever", description: "Loan days" }],
    ["PUT", "/api/rules/alert_thresholds", { value: { temperature: { min: 30, max: 10 } }, description: "Thresholds" }],
    ["POST", "/api/simulator/start", { speed: "fast" }],
    ["POST", "/api/simulator/start", { speed: -1 }],
    ["PATCH", "/api/simulator/speed", { speed: "fast" }],
    ["POST", "/api/simulator", { enabled: "yes" }],
    ["POST", "/api/simulator/scenario", { scenario: "meteor" }],
    ["POST", "/api/simulator/scenario", { scenario: "recover", branchId: 7 }]
  ];
  let harness: Harness;
  beforeAll(async () => { harness = await startServer(); });
  afterAll(async () => { await harness.close(); });

  for (const [method, path, payload] of invalid) {
    it(`${method} ${path} rejects ${JSON.stringify(payload).slice(0, 60)}`, async () => {
      const { status } = await call(harness.base, method, path, { cookie: cookies.admin, body: payload });
      expect(status).toBe(400);
    });
  }

  it("rejects unknown rule keys and malformed JSON without leaking a stack trace", async () => {
    expect((await call(harness.base, "PUT", "/api/rules/anything", { cookie: cookies.admin, body: { value: 1, description: "x" } })).status).toBe(404);
    const malformed = await call(harness.base, "POST", "/api/books", { cookie: cookies.admin, raw: "{\"title\":" });
    expect(malformed.status).toBe(400);
    expect(malformed.payload).toEqual({ code: "INVALID_INPUT", message: "Request body is invalid.", details: null });
  });
});

describe("personal data masking", () => {
  const raw = ["reader.demo@library.local", "20240001", "QR-20240001"];
  const leaks = (value: unknown) => raw.filter((secret) => JSON.stringify(value).includes(secret));

  it("masks reader records, exports, the audit log, and console logs", async () => {
    const harness = await startServer();
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    const log = vi.spyOn(console, "log").mockImplementation(capture);
    const error = vi.spyOn(console, "error").mockImplementation(capture);
    try {
      const list = await call(harness.base, "GET", "/api/readers", { cookie: cookies.librarian });
      const detail = await call(harness.base, "GET", "/api/readers/reader-001", { cookie: cookies.reader });
      const created = await call(harness.base, "POST", "/api/readers", { cookie: cookies.librarian, body: { username: "R-3001", display_name: "Created", email: "created@library.local", password_hash: "secret-hash", card_no: "20243001" } });
      const updated = await call(harness.base, "PATCH", "/api/readers/reader-001/status", { cookie: cookies.librarian, body: { status: "active" } });
      const exported = await call(harness.base, "GET", "/api/exports/preview?dataset=readers", { cookie: cookies.librarian });
      await call(harness.base, "POST", "/api/auth/card-login", { body: { cardNumber: "20240001" } });
      await call(harness.base, "POST", "/api/auth/card-login", { body: { cardNumber: "88887777" } });
      await call(harness.base, "POST", "/api/auth/login", { body: { role: "reader", account: "reader.demo@library.local", password: "wrong" } });

      for (const response of [list, detail, created, updated, exported]) {
        expect(response.status).toBeLessThan(300);
        expect(leaks(response.payload)).toEqual([]);
        expect(JSON.stringify(response.payload)).not.toContain("password_hash");
      }
      expect(JSON.stringify(created.payload)).not.toContain("created@library.local");
      const reader = (detail.payload as { data: Record<string, unknown> }).data;
      expect(reader).toMatchObject({ email: "r***@library.local", card_no: "****0001", id_number_masked: "3201********1024" });

      const audit = harness.repo.list("audit_log", { limit: 200 });
      expect(leaks(audit)).toEqual([]);
      expect(JSON.stringify(audit)).not.toContain("88887777");
      expect(leaks(lines)).toEqual([]);
    } finally {
      log.mockRestore();
      error.mockRestore();
      await harness.close();
    }
  });
});

describe("audit log", () => {
  it("is append-only in the repository and in SQLite", async () => {
    const harness = await startServer();
    try {
      const entry = harness.repo.recordAudit({ actor_id: null, action: "test", entity: "test", entity_id: "1", detail_json: "{}" }) as { id: string };
      const db = harness.repo["db" as keyof LibraryRepository] as unknown as import("better-sqlite3").Database;
      expect(() => harness.repo.update("audit_log", entry.id, { action: "tampered" })).toThrow("append-only");
      expect(() => harness.repo.delete("audit_log", entry.id)).toThrow("append-only");
      expect(() => db.prepare("UPDATE audit_log SET action = 'tampered' WHERE id = ?").run(entry.id)).toThrow("append-only");
      expect(() => db.prepare("DELETE FROM audit_log").run()).toThrow("append-only");
      expect(harness.repo.get("audit_log", entry.id)).toMatchObject({ action: "test" });
    } finally {
      await harness.close();
    }
  });

  it("has no HTTP route that updates or deletes it", () => {
    const writes = [...registeredRoutes()].filter((route) => /audit/i.test(route));
    expect(writes).toEqual([]);
    expect([...registeredRoutes()].filter((route) => route.startsWith("DELETE "))).toEqual([]);
  });
});
