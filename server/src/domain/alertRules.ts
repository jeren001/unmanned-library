import type { LibraryRepository } from "../persistence/repositories.js";
import type { EventBus } from "../events/bus.js";
import type { TelemetryReceivedEvent, GatePassedEvent, DeviceStatusChangedEvent } from "../events/types.js";

export class AlertRulesEngine {
  private readonly recent = new Map<string, number>();
  constructor(private readonly repo: LibraryRepository, private readonly bus: EventBus, private readonly dedupMs = 60_000) {
    bus.subscribe("telemetry.received", (event) => this.telemetry(event), { name: "alert-rules.telemetry" });
    bus.subscribe("gate.passed", (event) => this.gate(event), { name: "alert-rules.gate" });
    bus.subscribe("device.status_changed", (event) => this.device(event), { name: "alert-rules.device" });
  }
  private telemetry(event: TelemetryReceivedEvent) {
    const rules = new Map((this.repo.getRules() as Array<{ key: string; value_json: string }>).map((r) => [r.key, JSON.parse(r.value_json)]));
    const thresholds = (rules.get("alert_thresholds") ?? {}) as Record<string, { min?: number; max?: number }>;
    const threshold = thresholds[event.metric];
    if (event.quality === "dirty") return;
    if (threshold && ((threshold.min !== undefined && event.value < threshold.min) || (threshold.max !== undefined && event.value > threshold.max))) {
      const severity = event.metric === "smoke_ppm" ? "critical" : "warning";
      this.raise(event.branchId, event.deviceId, event.metric === "smoke_ppm" ? "smoke" : "threshold", severity, `${event.metric} threshold exceeded: ${event.value}`, event.ts);
    }
  }
  private gate(event: GatePassedEvent) {
    if (!event.authorized) {
      const clip = this.repo.findNearestClip(event.branchId, event.ts);
      this.raise(event.branchId, event.deviceId, "theft", "critical", `Unauthorized gate pass: ${event.rfidTags.join(",")}`, event.ts, clip?.id as string | undefined);
    }
  }
  private device(event: DeviceStatusChangedEvent) {
    if (event.to === "offline") this.raise(event.branchId, event.deviceId, "device_offline", "warning", `Device offline: ${event.deviceId}`, event.ts);
  }
  private raise(branchId: string, deviceId: string, type: "smoke" | "threshold" | "theft" | "device_offline", severity: "warning" | "critical", message: string, ts: string, clipId?: string) {
    const key = `${branchId}:${deviceId}:${type}`;
    const last = this.recent.get(key) ?? 0;
    if (Date.parse(ts) - last < this.dedupMs) return;
    this.recent.set(key, Date.parse(ts));
    const row = this.repo.insert("alerts", { branch_id: branchId, device_id: deviceId, type, severity, message, status: "open", related_clip_id: clipId ?? null });
    this.bus.publishNoWait("alert.raised", { alertId: String((row as { id: string }).id), branchId, deviceId, type, severity, message, status: "open", relatedClipId: clipId ?? null, ts });
  }
}
