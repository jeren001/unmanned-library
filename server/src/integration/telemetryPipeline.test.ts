import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { LibraryRepository } from "../persistence/repositories.js";
import { EventBus } from "../events/bus.js";
import { TelemetryPipeline } from "./telemetryPipeline.js";
import { LibrarySimulator } from "../simulator/index.js";

describe("TelemetryPipeline", () => {
  it("does not lose an overload batch and preserves dirty samples", async () => {
    const db = createDatabase(":memory:");
    const repo = new LibraryRepository(db);
    repo.insert("branches", { id: "branch-1", code: "B1", name_zh: "测试", name_en: "Test", type: "campus", address: "x", status: "active" });
    repo.insert("devices", { id: "d", branch_id: "branch-1", kind: "smoke", name: "Sensor", vendor: "test", protocol: "mock", address: "x", status: "online", config_json: "{}" });
    const bus = new EventBus();
    const pipeline = new TelemetryPipeline(repo, bus);
    for (let i = 0; i < 500; i += 1) pipeline.enqueue({ deviceId: "d", branchId: "branch-1", metric: "temperature", value: i === 7 ? 999999 : 22, ts: new Date(Date.now() + i).toISOString(), source: "test" });
    expect(await pipeline.flush()).toBe(500);
    expect(repo.telemetry({ branchId: "branch-1", metric: "temperature" })).toHaveLength(500);
    expect((repo.telemetry({ branchId: "branch-1", metric: "temperature" }) as Array<{ quality: string }>).some((row) => row.quality === "dirty")).toBe(true);
    db.close();
  });

  it("keeps samples enqueued during an overload flush for the next batch", async () => {
    const db = createDatabase(":memory:");
    const repo = new LibraryRepository(db);
    repo.insert("branches", { id: "branch-1", code: "B1", name_zh: "测试", name_en: "Test", type: "campus", address: "x", status: "active" });
    repo.insert("devices", { id: "d", branch_id: "branch-1", kind: "smoke", name: "Sensor", vendor: "test", protocol: "mock", address: "x", status: "online", config_json: "{}" });
    const bus = new EventBus();
    const pipeline = new TelemetryPipeline(repo, bus);
    let addedDuringFlush = 0;
    bus.subscribe("telemetry.received", () => {
      if (addedDuringFlush >= 50) return;
      addedDuringFlush += 1;
      pipeline.enqueue({
        deviceId: "d",
        branchId: "branch-1",
        metric: "temperature",
        value: 25,
        ts: new Date(Date.now() + 1_000 + addedDuringFlush).toISOString(),
        source: "test"
      });
    });
    for (let i = 0; i < 500; i += 1) {
      pipeline.enqueue({ deviceId: "d", branchId: "branch-1", metric: "temperature", value: 22, ts: new Date(Date.now() + i).toISOString(), source: "test" });
    }

    expect(await pipeline.flush()).toBe(500);
    expect(pipeline.size()).toBe(50);
    expect(await pipeline.flush()).toBe(50);
    expect(repo.telemetry({ branchId: "branch-1", metric: "temperature" })).toHaveLength(550);
    db.close();
  });

  it("supports the overload scenario through the simulator", async () => {
    const db = createDatabase(":memory:");
    const repo = new LibraryRepository(db);
    repo.insert("branches", { id: "branch-1", code: "B1", name_zh: "测试", name_en: "Test", type: "campus", address: "x", status: "active" });
    repo.insert("devices", { id: "sim-branch-1", branch_id: "branch-1", kind: "smoke", name: "Simulator", vendor: "test", protocol: "mock", address: "x", status: "online", config_json: "{}" });
    const simulator = new LibrarySimulator(repo, new EventBus(), { enabled: false });
    const result = await simulator.scenario("overload", "branch-1");
    expect(result.queued).toBe(0);
    expect(repo.telemetry({ branchId: "branch-1", metric: "overload_7" })).toHaveLength(1);
    db.close();
  });
});
