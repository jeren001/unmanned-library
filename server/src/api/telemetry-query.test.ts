import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { createServer } from "./server.js";
import type { LibraryRepository } from "../persistence/repositories.js";

process.env.SIMULATOR_ENABLED = "false";

/*
 * The admin Telemetry page asks GET /api/telemetry for one branch, one metric and one time window, and reads the
 * samples from data.series (docs/API.md). Every metric the page offers must come back for every seeded branch.
 */

const BRANCHES = ["branch-east", "branch-west", "branch-sunshine"];
const METRICS = ["temperature", "humidity", "light_lux", "smoke_ppm", "occupancy"];
const HOUR = 3600_000;
const now = Date.parse("2026-10-14T12:00:00.000Z");

let server: Server;
let app: ReturnType<typeof createServer>;
let base = "";
let cookie = "";

beforeAll(async () => {
  app = createServer(":memory:");
  const repo = app.locals.persistence.repo as LibraryRepository;
  repo.insert("users", { id: "admin-001", role: "admin", username: "admin", email: "admin@library.local", password_hash: bcrypt.hashSync("admin123", 4), display_name: "Admin", status: "active" });
  for (const branch of BRANCHES) {
    repo.insert("branches", { id: branch, code: branch.slice(7).toUpperCase(), name_zh: branch, name_en: branch, type: "campus", address: "-", status: "active" });
    repo.insert("devices", { id: `${branch}-sensor`, branch_id: branch, kind: "temp_humidity", name: "Sensor", vendor: "Mock", protocol: "mock", address: "mock://1", status: "online", config_json: "{}" });
    // One sample per metric per hour for the last 24 hours, like the seed.
    for (let hour = 0; hour < 24; hour += 1) {
      for (const metric of METRICS) {
        repo.insert("telemetry", { id: `${branch}-${metric}-${hour}`, device_id: `${branch}-sensor`, branch_id: branch, metric, value: 10 + hour, quality: "ok", ts: new Date(now - hour * HOUR).toISOString() });
      }
    }
  }
  server = await new Promise<Server>((resolve) => { const started = app.listen(0, "127.0.0.1", () => resolve(started)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "admin", account: "admin", password: "admin123" }) });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  app.locals.telemetryPipeline.stop();
  await app.locals.simulator.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.locals.persistence.db.close();
});

describe("GET /api/telemetry (Telemetry page query)", () => {
  for (const branchId of BRANCHES) {
    for (const metric of METRICS) {
      it(`returns ${metric} samples for ${branchId} in data.series`, async () => {
        // Exactly what web/src/admin/insightApi.ts fetchTelemetryRaw sends for one 24h window.
        const params = new URLSearchParams({ branchId, metric, from: new Date(now - 24 * HOUR).toISOString(), to: new Date(now).toISOString(), aggregate: "raw" });
        const response = await fetch(`${base}/api/telemetry?${params.toString()}`, { headers: { cookie } });
        expect(response.status).toBe(200);
        const { data } = await response.json() as { data: { branchId: string; metric: string; series: Array<Record<string, unknown>>; anomalies: unknown[] } };
        expect(data).toMatchObject({ branchId, metric, anomalies: [] });
        expect(data.series).toHaveLength(24);
        expect(data.series[0]).toMatchObject({ branch_id: branchId, metric, quality: "ok" });
        expect(Object.keys(data.series[0]!)).toEqual(expect.arrayContaining(["id", "device_id", "value", "ts"]));
        // Oldest first, as the page's windowing relies on it.
        expect(String(data.series[0]!.ts) < String(data.series.at(-1)!.ts)).toBe(true);
      });
    }
  }
});
