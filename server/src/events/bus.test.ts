import { describe, expect, it } from "vitest";
import { EventBus } from "./bus.js";
import { Logger } from "./logger.js";

describe("EventBus", () => {
  it("isolates failing handlers and logs duration for every handler", async () => {
    const records: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const bus = new EventBus({ logger: new Logger("test", (record) => records.push(record)) });
    const seen: string[] = [];
    bus.subscribe("gate.passed", () => { throw new Error("boom"); }, { name: "bad" });
    bus.subscribe("gate.passed", () => { seen.push("good"); }, { name: "good" });
    const result = await bus.publish("gate.passed", {
      gateEventId: "g1", branchId: "b1", deviceId: "d1", direction: "in", rfidTags: [], authorized: true, ts: new Date().toISOString()
    });
    expect(seen).toEqual(["good"]);
    expect(result.failed).toBe(1);
    expect(bus.stats().find((item) => item.handler === "bad")?.failures).toBe(1);
    expect(records.some((record) => record.message.includes("handler"))).toBe(true);
  });
});
