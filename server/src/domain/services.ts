import type { AlertQuery, LibraryRepository, Query } from "../persistence/repositories.js";
import { AuditService } from "./auditService.js";
import { CirculationService } from "./circulationService.js";
import { LoanPolicy } from "./loanPolicy.js";
import { asNumber, DomainError } from "./types.js";
import type { EventBus } from "../events/bus.js";
import type { AlertSeverity, AlertType } from "../events/types.js";
import { DeviceAdapterFactory } from "../integration/factory.js";
import type { DeviceAdapter } from "../integration/types.js";

class CrudService {
  constructor(protected readonly repo: LibraryRepository, protected readonly table: string) {}
  list(query?: Query) { return this.repo.list(this.table, query); }
  get(id: string) { const row = this.repo.get(this.table, id); if (!row) throw new DomainError("NOT_FOUND", `${this.table} record not found`); return row; }
  create(values: Record<string, unknown>) { return this.repo.insert(this.table, values); }
  update(id: string, values: Record<string, unknown>) { return this.repo.update(this.table, id, values); }
}

export class CatalogService extends CrudService { constructor(repo: LibraryRepository) { super(repo, "books"); } }
export class MemberService extends CrudService { constructor(repo: LibraryRepository) { super(repo, "users"); } }
export class BranchService extends CrudService { constructor(repo: LibraryRepository) { super(repo, "branches"); } }
export class NotificationService extends CrudService { constructor(repo: LibraryRepository) { super(repo, "notifications"); } }
export class DeviceService extends CrudService {
  private readonly adapters: DeviceAdapterFactory;
  constructor(repo: LibraryRepository, private readonly bus?: EventBus, adapters = new DeviceAdapterFactory()) {
    super(repo, "devices");
    this.adapters = adapters;
  }
  override list(query?: Query) {
    return super.list(query).map((row) => this.withConfig(row as Record<string, unknown>));
  }
  override get(id: string) {
    return this.withConfig(super.get(id) as Record<string, unknown>);
  }
  register(input: Record<string, unknown>) {
    const { config, ...values } = input;
    const row = this.repo.insert("devices", {
      ...values,
      status: input.status ?? "offline",
      config_json: JSON.stringify(config ?? {})
    });
    return this.withConfig(row as Record<string, unknown>);
  }
  updateConfig(id: string, config: Record<string, unknown>) {
    const row = this.repo.update("devices", id, { config_json: JSON.stringify(config) });
    if (!row) throw new DomainError("DEVICE_NOT_FOUND", "Device not found");
    return this.withConfig(row as Record<string, unknown>);
  }
  async command(id: string, command: string, payload: Record<string, unknown> = {}) {
    const row = this.repo.get("devices", id) as Record<string, unknown> | undefined;
    if (!row) throw new DomainError("DEVICE_NOT_FOUND", "Device not found");
    const adapter = this.adapter(row);
    await adapter.connect();
    const result = await adapter.command(command, payload);
    this.repo.update("devices", id, { last_seen_at: new Date().toISOString(), status: result.ok === false ? "fault" : "online" });
    return { device: this.withConfig(this.repo.get("devices", id) as Record<string, unknown>), result };
  }
  async healthCheck(id: string, actorId: string) {
    const row = this.repo.get("devices", id) as Record<string, unknown> | undefined;
    if (!row) throw new DomainError("DEVICE_NOT_FOUND", "Device not found");
    const adapter = this.adapter(row);
    await adapter.connect();
    const health = await adapter.health();
    const checkedAt = new Date().toISOString();
    this.repo.update("devices", id, {
      status: health.status === "online" ? "online" : "fault",
      last_seen_at: health.status === "online" ? checkedAt : null
    });
    if (health.status !== "online") {
      const alert = this.repo.insert("alerts", {
        branch_id: String(row.branch_id),
        device_id: id,
        type: "device_fault",
        severity: "warning",
        message: `Adapter health check failed: ${health.message ?? health.status}`,
        status: "open",
        related_loan_id: null,
        related_clip_id: null
      }) as Record<string, unknown>;
      this.bus?.publishNoWait("alert.raised", {
        alertId: String(alert.id),
        branchId: String(row.branch_id),
        deviceId: id,
        type: "device_fault",
        severity: "warning",
        message: String(alert.message),
        status: "open",
        relatedClipId: null,
        relatedLoanId: null,
        ts: checkedAt
      });
      const maintenance = this.repo.insert("maintenance_records", {
        branch_id: String(row.branch_id),
        device_id: id,
        kind: "device_repair",
        description: `Draft maintenance record: adapter health check failed (${health.status}).`,
        started_at: checkedAt,
        finished_at: null,
        operator_id: actorId,
        related_alert_id: String(alert.id)
      }) as Record<string, unknown>;
      return { health, device: this.withConfig(this.repo.get("devices", id) as Record<string, unknown>), alert, maintenance };
    }
    return { health, device: this.withConfig(this.repo.get("devices", id) as Record<string, unknown>) };
  }
  override update(id: string, values: Record<string, unknown>) {
    const before = this.repo.get("devices", id) as Record<string, unknown> | undefined;
    const result = super.update(id, values);
    const after = result as Record<string, unknown> | undefined;
    if (before && after && before.status !== after.status) {
      this.bus?.publishNoWait("device.status_changed", {
        deviceId: id,
        branchId: String(after.branch_id),
        name: String(after.name),
        kind: String(after.kind),
        from: before.status as "online" | "offline" | "fault",
        to: after.status as "online" | "offline" | "fault",
        reason: "api_update",
        ts: new Date().toISOString(),
        lastSeenAt: after.last_seen_at as string | null
      });
    }
    return result;
  }
  private adapter(row: Record<string, unknown>): DeviceAdapter {
    return this.adapters.create(row as never);
  }
  private withConfig(row: Record<string, unknown>) {
    let config: Record<string, unknown> = {};
    try {
      config = typeof row.config_json === "string" ? JSON.parse(row.config_json) as Record<string, unknown> : {};
    } catch {
      config = {};
    }
    return { ...row, config };
  }
}
export class MaintenanceService extends CrudService { constructor(repo: LibraryRepository) { super(repo, "maintenance_records"); } }

export class AlertService extends CrudService {
  constructor(repo: LibraryRepository, private readonly bus?: EventBus) { super(repo, "alerts"); }
  override list(query?: AlertQuery) {
    return this.repo.alertList(query);
  }
  detail(id: string) {
    const alert = this.repo.alertDetail(id);
    if (!alert) throw new DomainError("ALERT_NOT_FOUND", "Alert not found");
    return { ...alert, timeline: this.repo.alertTimeline(id) };
  }
  override create(values: Record<string, unknown>) {
    const result = super.create(values);
    const row = result as Record<string, unknown>;
    this.bus?.publishNoWait("alert.raised", {
      alertId: String(row.id), branchId: String(row.branch_id), deviceId: row.device_id as string | null,
      type: row.type as AlertType, severity: row.severity as AlertSeverity, message: String(row.message),
      status: String(row.status) as "open" | "acked" | "resolved", relatedClipId: row.related_clip_id as string | null,
      relatedLoanId: row.related_loan_id as string | null, ts: String(row.created_at)
    });
    return result;
  }
  ack(id: string, actorId: string, note?: string) {
    const existing = this.repo.get("alerts", id) as Record<string, unknown> | undefined;
    if (!existing) throw new DomainError("ALERT_NOT_FOUND", "Alert not found");
    const result = this.repo.update("alerts", id, { status: "acked", acked_by: actorId });
    const row = result as Record<string, unknown>;
    if (note) this.addNote(id, actorId, note, false);
    this.bus?.publishNoWait("alert.acked", {
      alertId: id, branchId: String(row.branch_id), deviceId: row.device_id as string | null,
      type: row.type as AlertType, severity: row.severity as AlertSeverity, message: String(row.message),
      status: "acked", relatedClipId: row.related_clip_id as string | null,
      relatedLoanId: row.related_loan_id as string | null, ackedBy: actorId, ts: new Date().toISOString()
    });
    return result;
  }
  bulkAck(ids: string[], actorId: string, note?: string) {
    return ids.map((id) => this.ack(id, actorId, note));
  }
  resolve(id: string, actorId?: string, note?: string) {
    const existing = this.repo.get("alerts", id) as Record<string, unknown> | undefined;
    if (!existing) throw new DomainError("ALERT_NOT_FOUND", "Alert not found");
    const result = this.repo.update("alerts", id, { status: "resolved", resolved_at: new Date().toISOString() });
    const row = result as Record<string, unknown>;
    if (note) this.addNote(id, actorId ?? null, note, false);
    this.bus?.publishNoWait("alert.resolved", {
      alertId: id, branchId: String(row.branch_id), deviceId: row.device_id as string | null,
      type: row.type as AlertType, severity: row.severity as AlertSeverity, message: String(row.message),
      status: "resolved", relatedClipId: row.related_clip_id as string | null,
      relatedLoanId: row.related_loan_id as string | null, ts: new Date().toISOString()
    });
    return result;
  }
  addNote(id: string, actorId: string | null, note: string, publish = true) {
    const alert = this.repo.get("alerts", id) as Record<string, unknown> | undefined;
    if (!alert) throw new DomainError("ALERT_NOT_FOUND", "Alert not found");
    const row = this.repo.insert("alert_notes", { alert_id: id, actor_id: actorId, note }) as Record<string, unknown>;
    if (publish) {
      this.bus?.publishNoWait("alert.noted", {
        alertId: id,
        branchId: String(alert.branch_id),
        deviceId: alert.device_id as string | null,
        type: alert.type as AlertType,
        severity: alert.severity as AlertSeverity,
        message: note,
        status: alert.status as "open" | "acked" | "resolved",
        relatedClipId: alert.related_clip_id as string | null,
        relatedLoanId: alert.related_loan_id as string | null,
        ts: String(row.created_at),
        actorId
      });
    }
    return row;
  }
}

export class TelemetryService {
  private readonly policy: LoanPolicy;
  constructor(private readonly repo: LibraryRepository) {
    this.policy = new LoanPolicy(repo);
  }
  query(query: Query & { metric?: string; from?: string; to?: string }) { return this.repo.telemetry(query); }
  ingest(input: { deviceId: string; branchId: string; metric: string; value: number; ts?: string }) {
    const quality = this.flagQuality(input.metric, input.value);
    return this.repo.ingestTelemetry({
      device_id: input.deviceId,
      branch_id: input.branchId,
      metric: input.metric,
      value: input.value,
      quality,
      ts: input.ts ?? new Date().toISOString()
    });
  }
  private flagQuality(metric: string, value: number) {
    if (!Number.isFinite(value)) return "dirty";
    const threshold = this.policy.values().thresholds[metric];
    if (threshold && ((threshold.min !== undefined && value < threshold.min) || (threshold.max !== undefined && value > threshold.max))) return "suspect";
    if (Math.abs(asNumber(value)) > 100000) return "dirty";
    return "ok";
  }
}

export class RuleService {
  constructor(private readonly repo: LibraryRepository) {}
  list() { return this.repo.getRules(); }
  upsert(key: string, value: unknown, description: string) { this.repo.upsertRule(key, value, description); return { key, value_json: JSON.stringify(value), description }; }
  latestAudit() { return this.repo.latestRuleAudit(); }
}

export function createDomainServices(repo: LibraryRepository, bus?: EventBus) {
  return {
    audit: new AuditService(repo),
    branches: new BranchService(repo),
    catalog: new CatalogService(repo),
    members: new MemberService(repo),
    notifications: new NotificationService(repo),
    devices: new DeviceService(repo, bus),
    alerts: new AlertService(repo, bus),
    telemetry: new TelemetryService(repo),
    maintenance: new MaintenanceService(repo),
    circulation: new CirculationService(repo, bus),
    rules: new RuleService(repo),
    stats: { overview: () => repo.overview() }
  };
}
