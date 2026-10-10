import { randomUUID } from "node:crypto";
import type { DeviceStatus } from "../events/types.js";
import type { DeviceAdapter, DeviceRecord, NormalizedGateEvent, NormalizedTelemetry } from "./types.js";
import { parseConfig } from "./types.js";

abstract class BaseAdapter implements DeviceAdapter {
  protected connected = false;
  protected readonly config: Record<string, unknown>;
  constructor(protected readonly device: DeviceRecord) { this.config = parseConfig(device); }
  async connect() { this.connected = true; }
  abstract read(): Promise<NormalizedTelemetry | NormalizedGateEvent | Record<string, unknown> | null>;
  async health() {
    const configured = this.config.healthStatus;
    const status: DeviceStatus = configured === "online" || configured === "offline" || configured === "fault"
      ? configured
      : this.connected ? "online" as const : "offline" as const;
    return { status, latencyMs: Number(this.config.healthLatencyMs ?? 1), message: typeof this.config.healthMessage === "string" ? this.config.healthMessage : undefined };
  }
  async command(command: string, payload: Record<string, unknown> = {}) { return { ok: true, command, payload, deviceId: this.device.id }; }
  protected telemetry(metric: string, value: number, unit?: string): NormalizedTelemetry {
    return { deviceId: this.device.id, branchId: this.device.branch_id, metric, value, unit, ts: new Date().toISOString(), source: this.device.vendor };
  }
}

export class TcpRfidAdapter extends BaseAdapter {
  async read() { return this.telemetry("rfid_reads", Number(this.config.reads ?? 0)); }
}
export class HttpCameraAdapter extends BaseAdapter {
  async read() { return { deviceId: this.device.id, branchId: this.device.branch_id, clipId: randomUUID(), ts: new Date().toISOString(), source: this.device.vendor }; }
}
export class HttpSensorAdapter extends BaseAdapter {
  async read() {
    const metric = String(this.config.metric ?? "temperature");
    return this.telemetry(metric, Number(this.config.value ?? 22));
  }
}
export class GateControllerAdapter extends BaseAdapter {
  async read(): Promise<NormalizedGateEvent> {
    return { gateEventId: randomUUID(), branchId: this.device.branch_id, deviceId: this.device.id, direction: "in", rfidTags: [], authorized: true, ts: new Date().toISOString() };
  }
}
export class MockAdapter extends BaseAdapter {
  async read() { return this.telemetry(String(this.config.metric ?? "heartbeat"), Number(this.config.value ?? 1)); }
}

/** Deliberately constrained legacy hardware: polling only, no commands. */
export class LegacyPollingAdapter implements DeviceAdapter {
  constructor(private readonly device: DeviceRecord) {}
  async connect() {}
  async read() { return { deviceId: this.device.id, branchId: this.device.branch_id, metric: "legacy_poll", value: 1, quality: "ok" as const, ts: new Date().toISOString(), source: "legacy-polling" }; }
  async command() { return { ok: false, error: "LEGACY_POLLING_ONLY" }; }
  async health() { return { status: "online" as const, latencyMs: 5, message: "Polling-only legacy adapter" }; }
}
