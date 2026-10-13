import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { LibraryRepository } from "../persistence/repositories.js";
import { EventBus } from "../events/bus.js";
import { AlertRulesEngine } from "./alertRules.js";
import { createDomainServices } from "./services.js";
import { LibrarySimulator } from "../simulator/index.js";

function setup() {
  const db = createDatabase(":memory:");
  const repo = new LibraryRepository(db);
  repo.insert("branches", { id: "branch-1", code: "B1", name_zh: "测试", name_en: "Test", type: "campus", address: "x", status: "active" });
  repo.insert("devices", { id: "device-1", branch_id: "branch-1", kind: "smoke", name: "Smoke", vendor: "x", protocol: "mock", address: "x", status: "online", config_json: "{}" });
  repo.insert("users", { id: "admin-1", role: "admin", username: "admin", email: "admin@test", password_hash: "hash", display_name: "Admin", status: "active", locked_until: null });
  repo.upsertRule("alert_thresholds", { smoke_ppm: { max: 8 } }, "test");
  const bus = new EventBus();
  new AlertRulesEngine(repo, bus, 60_000);
  return { db, repo, bus };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for expected alert state");
}

describe("AlertRulesEngine", () => {
  it("raises and deduplicates smoke alerts", async () => {
    const { db, repo, bus } = setup();
    const event = { deviceId: "device-1", branchId: "branch-1", metric: "smoke_ppm", value: 10, quality: "ok" as const, ts: new Date().toISOString(), source: "test" };
    await bus.publish("telemetry.received", event);
    await bus.publish("telemetry.received", event);
    expect(repo.list("alerts", { limit: 20 })).toHaveLength(1);
    expect((repo.list("alerts", { limit: 1 })[0] as { severity: string }).severity).toBe("critical");
    db.close();
  });

  it("turns a simulator scenario into an alert within 3 seconds, then ack and resolve events", async () => {
    const { db, repo, bus } = setup();
    repo.insert("devices", { id: "gate-1", branch_id: "branch-1", kind: "gate", name: "Gate", vendor: "x", protocol: "mock", address: "x", status: "online", config_json: "{}" });
    repo.insert("devices", { id: "camera-1", branch_id: "branch-1", kind: "camera", name: "Camera", vendor: "x", protocol: "mock", address: "x", status: "online", config_json: "{}" });
    repo.insert("camera_clips", {
      id: "clip-1",
      device_id: "camera-1",
      branch_id: "branch-1",
      start_ts: new Date(Date.now() - 1_000).toISOString(),
      end_ts: new Date(Date.now() + 1_000).toISOString(),
      file_path: "assets/placeholder.mp4"
    });
    const events: string[] = [];
    bus.subscribeAll((_payload, meta) => { events.push(meta.name); }, { name: "test.events" });
    const services = createDomainServices(repo, bus);
    const simulator = new LibrarySimulator(repo, bus, { enabled: false }, undefined);

    await simulator.scenario("illegal_exit", "branch-1");
    const alert = await waitFor(() => repo.alertList({ type: "theft", limit: 1 })[0] as { id: string; status: string; related_clip_id: string } | undefined);
    expect(alert.status).toBe("open");
    expect(alert.related_clip_id).toBe("clip-1");

    services.alerts.ack(alert.id, "admin-1", "Investigating");
    services.alerts.resolve(alert.id, "admin-1", "Resolved after checking camera clip");
    await bus.idle();
    const detail = services.alerts.detail(alert.id) as unknown as { status: string; timeline: Array<{ kind: string; message: string }> };
    expect(detail.status).toBe("resolved");
    expect(detail.timeline.map((item) => item.kind)).toEqual(expect.arrayContaining(["created", "acked", "resolved", "note"]));
    expect(events).toEqual(expect.arrayContaining(["gate.passed", "alert.raised", "alert.acked", "alert.resolved"]));
    db.close();
  });

  it("keeps one alert per device and metric while it is unresolved, however long the breach lasts", async () => {
    const { db, repo, bus } = setup();
    repo.upsertRule("alert_thresholds", { light_lux: { min: 10, max: 2000 }, temperature: { min: 10, max: 32 } }, "test");
    const sample = (metric: string, value: number, minutesFromNow: number) => ({ deviceId: "device-1", branchId: "branch-1", metric, value, quality: "ok" as const, ts: new Date(Date.now() + minutesFromNow * 60_000).toISOString(), source: "test" });
    const threshold = () => repo.alertList({ type: "threshold", limit: 50 }) as Array<{ id: string; message: string }>;

    for (let minute = 0; minute < 30; minute += 5) await bus.publish("telemetry.received", sample("light_lux", 2, minute));
    expect(threshold()).toHaveLength(1);
    // A different metric on the same device is a separate problem.
    await bus.publish("telemetry.received", sample("temperature", 40, 31));
    expect(threshold().map((alert) => alert.message.split(" ")[0]).sort()).toEqual(["light_lux", "temperature"]);
    // Once resolved, a new breach raises a new alert.
    const lux = threshold().find((alert) => alert.message.startsWith("light_lux"))!;
    repo.update("alerts", lux.id, { status: "resolved" });
    await bus.publish("telemetry.received", sample("light_lux", 2, 40));
    expect(threshold().filter((alert) => alert.message.startsWith("light_lux"))).toHaveLength(2);
    db.close();
  });

  it("does not alert on normal indoor light levels", async () => {
    const { db, repo, bus } = setup();
    repo.upsertRule("alert_thresholds", { light_lux: { min: 10, max: 2000 } }, "test");
    for (const value of [20, 35, 50, 65, 300, 800]) {
      await bus.publish("telemetry.received", { deviceId: "device-1", branchId: "branch-1", metric: "light_lux", value, quality: "ok" as const, ts: new Date().toISOString(), source: "test" });
    }
    expect(repo.alertList({ type: "threshold", limit: 10 })).toHaveLength(0);
    db.close();
  });
});
