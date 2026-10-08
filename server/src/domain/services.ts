import type { LibraryRepository, Query } from "../persistence/repositories.js";
import { AuditService } from "./auditService.js";
import { CirculationService } from "./circulationService.js";
import { LoanPolicy } from "./loanPolicy.js";
import { asNumber, DomainError } from "./types.js";
import type { EventBus } from "../events/bus.js";
import type { AlertSeverity, AlertType } from "../events/types.js";

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
  constructor(repo: LibraryRepository, private readonly bus?: EventBus) { super(repo, "devices"); }
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
}
export class MaintenanceService extends CrudService { constructor(repo: LibraryRepository) { super(repo, "maintenance_records"); } }

export class AlertService extends CrudService {
  constructor(repo: LibraryRepository, private readonly bus?: EventBus) { super(repo, "alerts"); }
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
  ack(id: string, actorId: string) {
    const result = this.repo.update("alerts", id, { status: "acked", acked_by: actorId });
    const row = result as Record<string, unknown>;
    this.bus?.publishNoWait("alert.acked", {
      alertId: id, branchId: String(row.branch_id), deviceId: row.device_id as string | null,
      type: row.type as AlertType, severity: row.severity as AlertSeverity, message: String(row.message),
      status: "acked", relatedClipId: row.related_clip_id as string | null,
      relatedLoanId: row.related_loan_id as string | null, ackedBy: actorId, ts: new Date().toISOString()
    });
    return result;
  }
  resolve(id: string) {
    const result = this.repo.update("alerts", id, { status: "resolved", resolved_at: new Date().toISOString() });
    return result;
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
