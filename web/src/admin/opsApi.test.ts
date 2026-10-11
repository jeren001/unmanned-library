import { afterEach, describe, expect, it, vi } from "vitest";
import { alertTimeline, fetchClip, mockDeviceTest, sortAlerts, type AlertFull, type DeviceRow, type MaintenanceRow } from "./adminApi";

afterEach(() => vi.unstubAllGlobals());

const alert = (patch: Partial<AlertFull>): AlertFull => ({
  id: "alert-1", branch_id: "branch-east", type: "smoke", severity: "warning", message: "Smoke rising", status: "open", created_at: "2026-10-09T10:00:00Z", ...patch
});

const device = (status: DeviceRow["status"]): DeviceRow => ({
  id: "device-east-1", branch_id: "branch-east", kind: "gate", name: "Gate 1", vendor: "Acme", protocol: "tcp", address: "10.0.0.5", status, config_json: "{}"
});

describe("alerts", () => {
  it("sorts by severity, then newest first", () => {
    const sorted = sortAlerts([
      alert({ id: "a", severity: "info", created_at: "2026-10-09T12:00:00Z" }),
      alert({ id: "b", severity: "critical", created_at: "2026-10-09T09:00:00Z" }),
      alert({ id: "c", severity: "warning", created_at: "2026-10-09T08:00:00Z" }),
      alert({ id: "d", severity: "critical", created_at: "2026-10-09T11:00:00Z" })
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("builds a timeline from fields and linked maintenance", () => {
    const records = [{ id: "m1", related_alert_id: "alert-1", started_at: "2026-10-09T10:30:00Z", description: "Replaced sensor" }] as MaintenanceRow[];
    const events = alertTimeline(alert({ status: "resolved", acked_at: "2026-10-09T10:05:00Z", resolved_at: "2026-10-09T11:00:00Z" }), records);
    expect(events.map((event) => event.kind)).toEqual(["resolved", "maintenance", "acked", "raised"]);
  });

  it("marks an acked time taken from updated_at as approximate", () => {
    const [acked] = alertTimeline(alert({ status: "acked", updated_at: "2026-10-09T10:10:00Z" }), []);
    expect(acked).toMatchObject({ kind: "acked", approximate: true });
  });

  it("falls back to a simulated clip window when the clip route is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const clip = await fetchClip(alert({ related_clip_id: "clip-9" }));
    expect(clip).toMatchObject({ id: "clip-9", url: null, simulated: true, start_ts: "2026-10-09T09:59:50.000Z" });
  });
});

describe("mockDeviceTest", () => {
  const instant = async () => undefined;
  it("answers by device status", async () => {
    await expect(mockDeviceTest(device("online"), "ping", instant)).resolves.toMatchObject({ ok: true, simulated: true });
    await expect(mockDeviceTest(device("offline"), "ping", instant)).resolves.toMatchObject({ ok: false, latencyMs: null });
    await expect(mockDeviceTest(device("fault"), "self_test", instant)).resolves.toMatchObject({ ok: false });
  });
});
