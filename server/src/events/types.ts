export type TelemetryQuality = "ok" | "suspect" | "dirty";
export type DeviceStatus = "online" | "offline" | "fault";
export type AlertType = "smoke" | "intrusion" | "theft" | "device_offline" | "device_fault" | "threshold" | "network";
export type AlertSeverity = "info" | "warning" | "critical";

export type TelemetryReceivedEvent = {
  deviceId: string;
  branchId: string;
  metric: string;
  value: number;
  unit?: string;
  quality: TelemetryQuality;
  ts: string;
  source: string;
  sampleId?: string;
};

export type CirculationEvent = {
  loanId: string;
  bookId: string;
  bookTitle?: string;
  userId: string;
  readerName?: string;
  branchId: string;
  deviceId?: string | null;
  action: "borrowed" | "returned" | "renewed";
  ts: string;
  dueAt?: string;
  renewCount?: number;
  actor?: string;
};

export type GatePassedEvent = {
  gateEventId: string;
  branchId: string;
  deviceId: string;
  direction: "in" | "out";
  rfidTags: string[];
  userId?: string | null;
  authorized: boolean;
  resolvedReader?: { id: string; displayName: string } | null;
  ts: string;
};

export type AlertEvent = {
  alertId: string;
  branchId: string;
  deviceId?: string | null;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  status: "open" | "acked" | "resolved";
  relatedClipId?: string | null;
  relatedLoanId?: string | null;
  dedupKey?: string;
  ts: string;
  ackedBy?: string | null;
  duplicate?: boolean;
};

export type DeviceStatusChangedEvent = {
  deviceId: string;
  branchId: string;
  name?: string;
  kind?: string;
  from: DeviceStatus;
  to: DeviceStatus;
  reason: string;
  ts: string;
  lastSeenAt?: string | null;
  missedIntervals?: number;
};

export type KpiUpdatedEvent = {
  branchId?: string | null;
  stats: {
    branches: number;
    books: number;
    readers: number;
    devicesOnline: number;
    devicesTotal?: number;
    activeLoans: number;
    openAlerts: number;
  };
  headcount?: number;
  ts: string;
};

export type EventMap = {
  "telemetry.received": TelemetryReceivedEvent;
  "circulation.borrowed": CirculationEvent;
  "circulation.returned": CirculationEvent;
  "circulation.renewed": CirculationEvent;
  "gate.passed": GatePassedEvent;
  "alert.raised": AlertEvent;
  "alert.acked": AlertEvent;
  "device.status_changed": DeviceStatusChangedEvent;
  "kpi.updated": KpiUpdatedEvent;
};

export type EventName = keyof EventMap;
export type EventEnvelope<N extends EventName = EventName> = {
  seq: number;
  name: N;
  payload: EventMap[N];
  ts: string;
};

export const EVENT_NAMES: EventName[] = [
  "telemetry.received",
  "circulation.borrowed",
  "circulation.returned",
  "circulation.renewed",
  "gate.passed",
  "alert.raised",
  "alert.acked",
  "device.status_changed",
  "kpi.updated"
];

export function isEventName(value: string): value is EventName {
  return (EVENT_NAMES as string[]).includes(value);
}
