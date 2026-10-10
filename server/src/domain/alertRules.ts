import type { LibraryRepository } from "../persistence/repositories.js";
import type { EventBus } from "../events/bus.js";
import type { AlertSeverity, AlertType, TelemetryReceivedEvent, GatePassedEvent, DeviceStatusChangedEvent } from "../events/types.js";

export class AlertRulesEngine {
  private readonly recent = new Map<string, number>();
  constructor(private readonly repo: LibraryRepository, private readonly bus: EventBus, private readonly dedupMs = 60_000) {
    bus.subscribe("telemetry.received", (event) => this.telemetry(event), { name: "alert-rules.telemetry" });
    bus.subscribe("gate.passed", (event) => this.gate(event), { name: "alert-rules.gate" });
    bus.subscribe("device.status_changed", (event) => this.device(event), { name: "alert-rules.device" });
  }
  private telemetry(event: TelemetryReceivedEvent) {
    const rules = this.rules();
    const thresholds = (rules.get("alert_thresholds") ?? {}) as Record<string, { min?: number; max?: number }>;
    const threshold = thresholds[event.metric];
    if (event.quality === "dirty") return;
    if (threshold && ((threshold.min !== undefined && event.value < threshold.min) || (threshold.max !== undefined && event.value > threshold.max))) {
      const severity = event.metric === "smoke_ppm" ? "critical" : "warning";
      this.raise(event.branchId, event.deviceId, event.metric === "smoke_ppm" ? "smoke" : "threshold", severity, `${event.metric} threshold exceeded: ${event.value}`, event.ts);
    }
  }
  private gate(event: GatePassedEvent) {
    if (!event.authorized || event.rfidTags.some((tag) => /^RFID-UNKNOWN/i.test(tag))) {
      const clip = this.repo.findNearestClip(event.branchId, event.ts);
      this.raise(event.branchId, event.deviceId, "theft", "critical", `Unauthorized gate pass: ${event.rfidTags.join(",")}`, event.ts, clip?.id as string | undefined);
    }
  }
  private device(event: DeviceStatusChangedEvent) {
    const rules = this.rules();
    const missedIntervals = Number(rules.get("heartbeat_missed_intervals") ?? 3);
    if (event.to === "offline" && (event.missedIntervals === undefined || event.missedIntervals >= missedIntervals)) {
      this.raise(event.branchId, event.deviceId, "device_offline", "warning", `Device offline: ${event.deviceId}`, event.ts);
    }
  }
  private raise(branchId: string, deviceId: string, type: AlertType, severity: AlertSeverity, message: string, ts: string, clipId?: string) {
    const key = `${branchId}:${deviceId}:${type}`;
    const dedupMs = this.dedupWindowMs();
    const last = this.recent.get(key) ?? 0;
    const timestamp = Number.isFinite(Date.parse(ts)) ? Date.parse(ts) : Date.now();
    if (timestamp - last < dedupMs) return;
    const since = new Date(timestamp - dedupMs).toISOString();
    if (this.repo.findRecentOpenAlert({ branchId, deviceId, type, since })) {
      this.recent.set(key, timestamp);
      return;
    }
    this.recent.set(key, timestamp);
    const row = this.repo.insert("alerts", { branch_id: branchId, device_id: deviceId, type, severity, message, status: "open", related_clip_id: clipId ?? null });
    this.bus.publishNoWait("alert.raised", { alertId: String((row as { id: string }).id), branchId, deviceId, type, severity, message, status: "open", relatedClipId: clipId ?? null, ts });
  }
  private rules() {
    return new Map((this.repo.getRules() as Array<{ key: string; value_json: string }>).map((rule) => {
      try {
        return [rule.key, JSON.parse(rule.value_json)] as const;
      } catch {
        return [rule.key, null] as const;
      }
    }));
  }
  private dedupWindowMs() {
    const configured = Number(this.rules().get("alert_dedup_seconds"));
    return Number.isFinite(configured) && configured > 0 ? configured * 1000 : this.dedupMs;
  }
}
