import { describe, expect, it } from "vitest";
import { addToHour, bucketHourly, envLevel, flowRoute, pushPoint, sparklinePoints } from "./wallboardData";

const now = new Date(2026, 9, 9, 15, 30);
const at = (hour: number, day = 9) => new Date(2026, 9, day, hour, 5).toISOString();

describe("bucketHourly", () => {
  it("counts only today's borrows and returns per local hour", () => {
    const buckets = bucketHourly([
      { borrowed_at: at(9), returned_at: at(14) },
      { borrowed_at: at(9), returned_at: null },
      { borrowed_at: at(10, 8), returned_at: at(11) }
    ], now);
    expect(buckets.borrowed[9]).toBe(2);
    expect(buckets.borrowed[10]).toBe(0);
    expect(buckets.returned[14]).toBe(1);
    expect(buckets.returned[11]).toBe(1);
  });

  it("adds live events to the right hour", () => {
    const next = addToHour(bucketHourly([], now), "borrowed", at(15), now);
    expect(next.borrowed[15]).toBe(1);
    expect(addToHour(next, "borrowed", at(15, 8), now)).toBe(next);
  });
});

describe("environment", () => {
  it("grades readings", () => {
    expect(envLevel("temperature", 22)).toBe("ok");
    expect(envLevel("temperature", 27)).toBe("warn");
    expect(envLevel("smoke_ppm", 20)).toBe("critical");
    expect(envLevel("humidity", undefined)).toBe("ok");
  });

  it("keeps a bounded series and draws a sparkline", () => {
    expect(pushPoint([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(sparklinePoints([0, 10], 100, 28)).toBe("0.0,26.0 100.0,2.0");
    expect(sparklinePoints([5])).toBe("");
  });
});

describe("flowRoute", () => {
  it("routes kiosk events to the dashboard and alerts to the alert feed", () => {
    expect(flowRoute("circulation.borrowed")).toEqual({ from: "kiosk", to: ["dashboard"] });
    expect(flowRoute("alert.raised")).toEqual({ from: "sensors", to: ["alerts"] });
    expect(flowRoute("device.status_changed").to).toContain("alerts");
  });
});
