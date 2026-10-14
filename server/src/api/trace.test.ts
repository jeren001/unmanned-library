import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { createServer } from "./server.js";
import type { LibraryRepository } from "../persistence/repositories.js";

process.env.SIMULATOR_ENABLED = "false";

/*
 * GET /api/trace resolves every input the trace page accepts (title, loan ID, RFID tag, ISBN, book ID)
 * to the full chain, and answers an unknown input with 404 TRACE_NOT_FOUND.
 */

const borrowedAt = new Date(Date.now() - 3 * 86400_000);
const at = (minutes: number) => new Date(borrowedAt.getTime() + minutes * 60_000).toISOString();

function seed(repo: LibraryRepository) {
  repo.insert("branches", { id: "branch-east", code: "EAST", name_zh: "东馆", name_en: "East", type: "campus", address: "East", status: "active" });
  repo.insert("users", { id: "admin-001", role: "admin", username: "admin", email: "admin@library.local", password_hash: bcrypt.hashSync("admin123", 4), display_name: "Admin", status: "active" });
  repo.insert("users", { id: "reader-001", role: "reader", username: "R-2048", email: "reader@library.local", password_hash: "x", display_name: "林知秋", card_no: "20240001", status: "active" });
  repo.insert("books", { id: "book-0049", isbn: "978-7-111-54493-7", title: "软件体系结构（第 2 版）", author: "Mary Shaw", category: "TP311", branch_id: "branch-east", shelf_location: "A-3-2", edition: "2", purchased_at: "2026-01-01", rfid_tag: "RFID-000010", cover_color: "#8E1B2E", status: "borrowed" });
  repo.insert("devices", { id: "device-kiosk", branch_id: "branch-east", kind: "kiosk", name: "East kiosk", vendor: "Mock", protocol: "mock", address: "mock://kiosk", status: "online", config_json: "{}" });
  repo.insert("devices", { id: "device-gate", branch_id: "branch-east", kind: "gate", name: "East gate", vendor: "Mock", protocol: "mock", address: "mock://gate", status: "online", config_json: "{}" });
  repo.insert("devices", { id: "device-camera", branch_id: "branch-east", kind: "camera", name: "East camera", vendor: "Mock", protocol: "mock", address: "mock://camera", status: "online", config_json: "{}" });
  repo.insert("loans", { id: "loan-00009", book_id: "book-0049", user_id: "reader-001", branch_id: "branch-east", device_id: "device-kiosk", borrowed_at: borrowedAt.toISOString(), due_at: new Date(borrowedAt.getTime() + 30 * 86400_000).toISOString(), status: "active", idempotency_key: "trace-loan-00009" });
  repo.insertGateEvent({ id: "gate-1", branch_id: "branch-east", device_id: "device-gate", direction: "out", rfid_tags_json: JSON.stringify(["RFID-000010"]), authorized: 1, ts: at(2) });
  repo.insert("camera_clips", { id: "clip-1", device_id: "device-camera", branch_id: "branch-east", start_ts: at(1), end_ts: at(3), file_path: "assets/clip-1.mp4" });
  const alert = repo.insert("alerts", { id: "alert-1", branch_id: "branch-east", device_id: "device-gate", type: "theft", severity: "critical", message: "Gate check", status: "resolved", related_loan_id: "loan-00009", related_clip_id: "clip-1" }) as { id: string };
  repo.insert("maintenance_records", { id: "maint-1", branch_id: "branch-east", device_id: "device-gate", kind: "device_repair", description: "Recalibrate gate antenna", started_at: at(10), related_alert_id: alert.id });
}

let server: Server;
let app: ReturnType<typeof createServer>;
let base = "";
let cookie = "";

beforeAll(async () => {
  app = createServer(":memory:");
  seed(app.locals.persistence.repo as LibraryRepository);
  server = await new Promise<Server>((resolve) => { const started = app.listen(0, "127.0.0.1", () => resolve(started)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "admin", account: "admin", password: "admin123" }) });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
});

afterAll(async () => {
  app.locals.telemetryPipeline.stop();
  await app.locals.simulator.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.locals.persistence.db.close();
});

async function trace(query: Record<string, string>) {
  const response = await fetch(`${base}/api/trace?${new URLSearchParams(query).toString()}`, { headers: { cookie } });
  return { status: response.status, body: await response.json() as { data?: { chain: Array<{ kind: string; record: Record<string, unknown> }> }; code?: string } };
}

const FULL_CHAIN = ["book", "rfid_tag", "loan_transaction", "device_event", "camera_clip", "alert", "maintenance"];

describe("GET /api/trace", () => {
  it.each<[string, Record<string, string>]>([
    ["title", { book: "软件体系结构" }],
    ["loan ID", { loanId: "loan-00009" }],
    ["RFID tag", { book: "RFID-000010" }],
    ["ISBN", { book: "978-7-111-54493-7" }],
    ["book ID", { book: "book-0049" }]
  ])("returns the full chain for a %s", async (_label, query) => {
    const { status, body } = await trace(query);
    expect(status).toBe(200);
    const chain = body.data!.chain;
    expect([...new Set(chain.map((step) => step.kind))]).toEqual(FULL_CHAIN);
    expect(chain[0]!.record.id).toBe("book-0049");
    expect(chain.find((step) => step.kind === "rfid_tag")!.record.tag).toBe("RFID-000010");
    expect(chain.find((step) => step.kind === "loan_transaction")!.record.id).toBe("loan-00009");
    expect(chain.filter((step) => step.kind === "device_event").map((step) => step.record.device_id)).toEqual(["device-kiosk", "device-gate"]);
    expect(chain.find((step) => step.kind === "camera_clip")!.record.id).toBe("clip-1");
    expect(chain.find((step) => step.kind === "alert")!.record.id).toBe("alert-1");
    expect(chain.find((step) => step.kind === "maintenance")!.record.id).toBe("maint-1");
  });

  it("answers an input with no match with 404 TRACE_NOT_FOUND", async () => {
    for (const query of [{ book: "没有这本书" }, { loanId: "loan-99999" }, { book: "RFID-999999" }] as Array<Record<string, string>>) {
      const { status, body } = await trace(query);
      expect(status).toBe(404);
      expect(body.code).toBe("TRACE_NOT_FOUND");
    }
  });
});
