import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { LibraryRepository } from "../persistence/repositories.js";
import { EventBus } from "../events/bus.js";
import { AlertRulesEngine } from "./alertRules.js";

function setup() {
  const db = createDatabase(":memory:");
  const repo = new LibraryRepository(db);
  repo.insert("branches", { id: "branch-1", code: "B1", name_zh: "测试", name_en: "Test", type: "campus", address: "x", status: "active" });
  repo.insert("devices", { id: "device-1", branch_id: "branch-1", kind: "smoke", name: "Smoke", vendor: "x", protocol: "mock", address: "x", status: "online", config_json: "{}" });
  repo.upsertRule("alert_thresholds", { smoke_ppm: { max: 8 } }, "test");
  const bus = new EventBus();
  new AlertRulesEngine(repo, bus, 60_000);
  return { db, repo, bus };
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
});
