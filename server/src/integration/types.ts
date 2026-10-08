import type { DeviceStatus } from "../events/types.js";

export type DeviceRecord = {
  id: string;
  branch_id: string;
  kind: string;
  name: string;
  vendor: string;
  protocol: string;
  address: string;
  status: DeviceStatus;
  config_json?: string;
};

export type NormalizedTelemetry = {
  deviceId: string;
  branchId: string;
  metric: string;
  value: number;
  unit?: string;
  quality?: "ok" | "suspect" | "dirty";
  ts: string;
  source: string;
};

export type NormalizedGateEvent = {
  gateEventId: string;
  branchId: string;
  deviceId: string;
  direction: "in" | "out";
  rfidTags: string[];
  userId?: string | null;
  authorized: boolean;
  ts: string;
};

export interface DeviceAdapter {
  connect(): Promise<void>;
  read(): Promise<NormalizedTelemetry | NormalizedGateEvent | Record<string, unknown> | null>;
  command(command: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
  health(): Promise<{ status: DeviceStatus; latencyMs: number; message?: string }>;
}

export function parseConfig(device: DeviceRecord) {
  try {
    return JSON.parse(device.config_json ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
