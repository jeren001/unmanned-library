import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { LibraryRepository } from "../persistence/repositories.js";
import { EventBus } from "../events/bus.js";
import { AlertRulesEngine } from "../domain/alertRules.js";
import { LibrarySimulator, type Scenario } from "./index.js";

function fixture() {
  const db = createDatabase(":memory:");
  const repo = new LibraryRepository(db);
  repo.insert("branches", { id: "branch-1", code: "B1", name_zh: "测试", name_en: "Test", type: "campus", address: "x", status: "active" });
  repo.insert("devices", { id: "smoke-1", branch_id: "branch-1", kind: "smoke", name: "Smoke", vendor: "x", protocol: "mock", address: "smoke://1", status: "online", config_json: "{}" });
  repo.insert("devices", { id: "gate-1", branch_id: "branch-1", kind: "gate", name: "Gate", vendor: "x", protocol: "mock", address: "gate://1", status: "online", config_json: "{}" });
  repo.insert("devices", { id: "camera-1", branch_id: "branch-1", kind: "camera", name: "Camera", vendor: "x", protocol: "mock", address: "camera://1", status: "online", config_json: "{}" });
  repo.insert("camera_clips", {
    id: "clip-1",
    device_id: "camera-1",
    branch_id: "branch-1",
    start_ts: new Date(Date.now() - 1_000).toISOString(),
    end_ts: new Date(Date.now() + 1_000).toISOString(),
    file_path: "assets/placeholder.mp4"
  });
  repo.upsertRule("alert_thresholds", { smoke_ppm: { max: 8 }, temperature: { min: 10, max: 32 } }, "test thresholds");
  repo.upsertRule("heartbeat_missed_intervals", 3, "test heartbeat");
  const bus = new EventBus();
  new AlertRulesEngine(repo, bus, 0);
  const events: string[] = [];
  bus.subscribeAll((_payload, meta) => { events.push(meta.name); }, { name: "simulator-test" });
  const simulator = new LibrarySimulator(repo, bus, { enabled: false, intervalMs: 1_000 });
  return { db, repo, bus, simulator, events };
}

describe("LibrarySimulator controls", () => {
  it("starts, stops, changes speed, and emits live simulator log events", async () => {
    const { db, bus, simulator, events } = fixture();
    expect(simulator.startControl(2)).toMatchObject({ enabled: true, running: true, speed: 2, intervalMs: 500 });
    expect(simulator.setSpeed(4)).toMatchObject({ speed: 4, intervalMs: 250 });
    await simulator.stop();
    await bus.idle();
    expect(simulator.status()).toMatchObject({ running: false, speed: 4 });
    expect(events).toEqual(expect.arrayContaining(["simulator.log"]));
    db.close();
  });

  it.each([
    ["smoke_spike", "smoke"],
    ["device_offline", "device_offline"],
    ["illegal_exit", "theft"],
    ["network_outage", "device_offline"]
  ] as Array<[Scenario, string]>)("scenario %s produces expected alert/status", async (scenario, alertType) => {
    const { db, repo, bus, simulator, events } = fixture();
    const result = await simulator.scenario(scenario, "branch-1") as { alerts?: Array<{ type: string; status: string }>; device?: { id: string; status: string } };
    await bus.idle();
    expect(result.alerts?.some((alert) => alert.type === alertType && alert.status === "open")).toBe(true);
    expect(repo.alertList({ type: alertType, branchId: "branch-1", limit: 10 })).not.toHaveLength(0);
    if (scenario === "device_offline" || scenario === "network_outage") {
      expect(result.device?.status).toBe("offline");
      expect((repo.get("devices", result.device!.id) as { status: string }).status).toBe("offline");
    }
    expect(events).toEqual(expect.arrayContaining(["simulator.log", "alert.raised"]));
    db.close();
  });

  it("sensor_glitch stores dirty telemetry and overload persists the whole burst", async () => {
    const { db, repo, simulator, events } = fixture();
    const glitch = await simulator.scenario("sensor_glitch", "branch-1") as { dirtySamples: number };
    expect(glitch.dirtySamples).toBeGreaterThan(0);
    expect(repo.telemetry({ branchId: "branch-1", metric: "temperature" }).some((row) => (row as { quality: string }).quality === "dirty")).toBe(true);

    const overload = await simulator.scenario("overload", "branch-1") as { persisted: boolean };
    expect(overload.persisted).toBe(true);
    expect(repo.telemetry({ branchId: "branch-1", metric: "overload_7" })).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining(["simulator.log", "telemetry.received"]));
    db.close();
  });

  it("recover restores offline devices and publishes a status change", async () => {
    const { db, repo, simulator, events } = fixture();
    repo.update("devices", "smoke-1", { status: "offline", last_seen_at: null });
    const result = await simulator.scenario("recover", "branch-1") as { recovered: number };
    expect(result.recovered).toBe(1);
    expect((repo.get("devices", "smoke-1") as { status: string; last_seen_at: string | null }).status).toBe("online");
    expect(events).toEqual(expect.arrayContaining(["simulator.log", "device.status_changed"]));
    db.close();
  });
});
