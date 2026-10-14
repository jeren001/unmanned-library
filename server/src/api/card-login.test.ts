import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { createServer } from "./server.js";
import type { LibraryRepository } from "../persistence/repositories.js";

process.env.SIMULATOR_ENABLED = "false";

/* A typed card number needs the reader's PIN; the simulated card reader (demo mode only) does not. */

let server: Server;
let app: ReturnType<typeof createServer>;
let repo: LibraryRepository;
let base = "";

beforeAll(async () => {
  app = createServer(":memory:");
  repo = app.locals.persistence.repo as LibraryRepository;
  const reader = { role: "reader", password_hash: bcrypt.hashSync("reader123", 4), status: "active" };
  repo.insert("users", { ...reader, id: "reader-001", username: "R-2048", email: "reader.demo@library.local", display_name: "林知秋", card_no: "20240001" });
  repo.insert("users", { ...reader, id: "reader-002", username: "R-2049", email: "lock.reader@library.local", display_name: "Lock", card_no: "20240002" });
  server = await new Promise<Server>((resolve) => { const started = app.listen(0, "127.0.0.1", () => resolve(started)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  app.locals.telemetryPipeline.stop();
  await app.locals.simulator.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.locals.persistence.db.close();
});

const demoMode = process.env.DEMO_MODE;
afterEach(() => {
  if (demoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = demoMode;
});

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}/api/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as { code?: string; user?: { id: string } }, cookie: response.headers.get("set-cookie") };
}

function lastCardAudit() {
  const rows = repo.list("audit_log", { limit: 500 }) as Array<{ action: string; detail_json: string; ts: string }>;
  const row = rows.filter((entry) => entry.action === "card-login").sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)!;
  return JSON.parse(row.detail_json) as { success: boolean; reason?: string; method?: string };
}

describe("card login", () => {
  it("rejects a card number without a PIN", async () => {
    expect((await post("card-login", { cardNumber: "20240001" })).status).toBe(400);
  });

  it("gives a wrong PIN and an unknown card the same 401, and audits both", async () => {
    const wrongPin = await post("card-login", { cardNumber: "20240001", pin: "nope" });
    expect(lastCardAudit()).toMatchObject({ success: false, reason: "wrong-pin", method: "pin" });
    const unknownCard = await post("card-login", { cardNumber: "99990000", pin: "nope" });
    expect(lastCardAudit()).toMatchObject({ success: false, reason: "unknown-card", method: "pin" });
    expect(wrongPin.status).toBe(401);
    expect(unknownCard.status).toBe(401);
    expect(wrongPin.body).toEqual(unknownCard.body);
    expect(wrongPin.cookie).toBeNull();
  });

  it("signs in with the correct PIN", async () => {
    const result = await post("card-login", { cardNumber: "20240001", pin: "reader123" });
    expect(result.status).toBe(200);
    expect(result.body.user?.id).toBe("reader-001");
    expect(result.cookie).toMatch(/^ul_session=/);
    expect(lastCardAudit()).toMatchObject({ success: true, method: "pin" });
  });

  it("locks the account after five wrong PINs", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await post("card-login", { cardNumber: "20240002", pin: `bad-${i}` })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 423]);
    const locked = await post("card-login", { cardNumber: "20240002", pin: "reader123" });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe("ACCOUNT_LOCKED");
  });
});

describe("card scan", () => {
  it("signs in without a PIN in demo mode, audited as a scan", async () => {
    process.env.DEMO_MODE = "true";
    const result = await post("card-scan", { cardNumber: "20240001" });
    expect(result.status).toBe(200);
    expect(result.body.user?.id).toBe("reader-001");
    expect(result.cookie).toMatch(/^ul_session=/);
    expect(lastCardAudit()).toMatchObject({ success: true, method: "scan" });
  });

  it("does not exist outside demo mode", async () => {
    process.env.DEMO_MODE = "false";
    const result = await post("card-scan", { cardNumber: "20240001" });
    expect(result.status).toBe(404);
    expect(result.cookie).toBeNull();
  });
});
