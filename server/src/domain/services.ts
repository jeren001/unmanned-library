import ExcelJS from "exceljs";
import type { AlertQuery, ExportDataset, ExportLocale, ExportQuery, LibraryRepository, MaintenanceQuery, Query, TelemetryQuery, TraceQuery } from "../persistence/repositories.js";
import { AuditService } from "./auditService.js";
import { CirculationService } from "./circulationService.js";
import { LoanPolicy } from "./loanPolicy.js";
import { asNumber, DomainError } from "./types.js";
import { maskUser } from "./privacy.js";
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
export class MemberService extends CrudService {
  constructor(repo: LibraryRepository) { super(repo, "users"); }
  override list(query?: Query) { return (super.list(query) as Array<Record<string, unknown>>).map(maskUser); }
  override get(id: string) { return maskUser(super.get(id) as Record<string, unknown>); }
  override create(values: Record<string, unknown>) { return maskUser(super.create(values) as Record<string, unknown>); }
  override update(id: string, values: Record<string, unknown>) { return maskUser(super.update(id, values) as Record<string, unknown>); }
}
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
export class MaintenanceService extends CrudService {
  constructor(repo: LibraryRepository) { super(repo, "maintenance_records"); }
  override list(query?: MaintenanceQuery) {
    return this.repo.maintenanceList(query);
  }
  override create(values: Record<string, unknown>) {
    const row = this.repo.insert("maintenance_records", values);
    return this.withStatus(row as Record<string, unknown>);
  }
  override update(id: string, values: Record<string, unknown>) {
    const existing = this.repo.get("maintenance_records", id) as Record<string, unknown> | undefined;
    if (!existing) throw new DomainError("MAINTENANCE_NOT_FOUND", "Maintenance record not found");
    const row = this.repo.update("maintenance_records", id, values);
    return this.withStatus(row as Record<string, unknown>);
  }
  complete(id: string, values: { finished_at?: string; operator_id?: string | null; description?: string; related_alert_id?: string | null }) {
    const existing = this.repo.get("maintenance_records", id) as Record<string, unknown> | undefined;
    if (!existing) throw new DomainError("MAINTENANCE_NOT_FOUND", "Maintenance record not found");
    const update: Record<string, unknown> = { finished_at: values.finished_at ?? new Date().toISOString() };
    if (values.operator_id !== undefined) update.operator_id = values.operator_id;
    if (values.description !== undefined) update.description = values.description;
    if (values.related_alert_id !== undefined) update.related_alert_id = values.related_alert_id;
    return this.withStatus(this.repo.update("maintenance_records", id, update) as Record<string, unknown>);
  }
  timeline(days = 30, query: Pick<MaintenanceQuery, "branchId" | "deviceId"> = {}) {
    return this.repo.maintenanceTimeline(days, query);
  }
  private withStatus(row: Record<string, unknown>) {
    return { ...row, status: row.finished_at ? "completed" : "open" };
  }
}

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
  query(query: TelemetryQuery) {
    const mode = query.mode ?? "raw";
    const aggregate = query.aggregate ?? "raw";
    const normalized = { ...query, mode, aggregate };
    const rawRows = this.repo.telemetryRows({ ...normalized, mode: "raw" }) as Array<Record<string, unknown>>;
    const series = aggregate === "raw"
      ? this.repo.telemetryRows(normalized)
      : this.repo.telemetryAggregate(normalized);
    const response: Record<string, unknown> = {
      branchId: query.branchId,
      metric: query.metric,
      from: query.from ?? null,
      to: query.to ?? null,
      aggregate,
      mode,
      series,
      anomalies: this.anomalies(rawRows)
    };
    if (query.compareBranchId) {
      const comparisonAggregate = aggregate === "raw" ? "hourly" : aggregate;
      const base = this.repo.telemetryBranchAggregate({ ...normalized, aggregate: comparisonAggregate }, query.branchId) as Array<Record<string, unknown>>;
      const compare = this.repo.telemetryBranchAggregate({ ...normalized, branchId: query.compareBranchId, aggregate: comparisonAggregate }, query.compareBranchId) as Array<Record<string, unknown>>;
      response.comparison = this.compare(query.branchId, query.compareBranchId, comparisonAggregate, base, compare);
    }
    return response;
  }
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
  archive(options: { now?: Date; olderThanYears?: number } = {}) {
    // Cut on an hour boundary so an hour is never split between telemetry and telemetry_archive.
    const cutoffDate = new Date(options.now ?? new Date());
    cutoffDate.setUTCFullYear(cutoffDate.getUTCFullYear() - (options.olderThanYears ?? 2));
    cutoffDate.setUTCMinutes(0, 0, 0);
    const cutoff = cutoffDate.toISOString();
    return { moved: this.repo.archiveTelemetryBefore(cutoff), cutoff };
  }
  private flagQuality(metric: string, value: number) {
    if (!Number.isFinite(value)) return "dirty";
    const threshold = this.policy.values().thresholds[metric];
    if (threshold && ((threshold.min !== undefined && value < threshold.min) || (threshold.max !== undefined && value > threshold.max))) return "suspect";
    if (Math.abs(asNumber(value)) > 100000) return "dirty";
    return "ok";
  }
  private anomalies(rows: Array<Record<string, unknown>>) {
    const ranges: Record<string, { min: number; max: number; jump: number }> = {
      temperature: { min: -30, max: 60, jump: 15 },
      humidity: { min: 0, max: 100, jump: 50 },
      light_lux: { min: 0, max: 100_000, jump: 5_000 },
      smoke_ppm: { min: 0, max: 1_000, jump: 50 },
      occupancy: { min: 0, max: 10_000, jump: 5_000 },
      headcount: { min: 0, max: 10_000, jump: 5_000 },
      heartbeat: { min: 0, max: 1, jump: 1 }
    };
    const previous = new Map<string, { value: number; ts: number }>();
    return rows.flatMap((row) => {
      const value = asNumber(row.value);
      const metric = String(row.metric);
      const quality = String(row.quality);
      const ts = String(row.ts);
      const parsedTs = Date.parse(ts);
      const key = `${String(row.device_id)}:${metric}`;
      const prior = previous.get(key);
      const range = ranges[metric];
      const reasons = new Set<string>();
      if (quality === "dirty" || !Number.isFinite(value) || Math.abs(value) > 100000) reasons.add("garbage_after_outage");
      if (range && (value < range.min || value > range.max)) reasons.add("out_of_range");
      if (!Number.isFinite(parsedTs) || (prior && parsedTs <= prior.ts) || (quality === "suspect" && Number.isFinite(parsedTs) && Date.now() - parsedTs > 24 * 60 * 60 * 1000)) reasons.add("stale");
      if (prior && range && Math.abs(value - prior.value) > range.jump) reasons.add("jump");
      if (quality === "suspect" && reasons.size === 0) reasons.add("out_of_range");
      if (Number.isFinite(parsedTs)) previous.set(key, { value, ts: parsedTs });
      if (reasons.size === 0) return [];
      return [{
        sampleId: row.id,
        branch_id: row.branch_id,
        device_id: row.device_id,
        metric,
        value,
        quality,
        ts,
        reasons: [...reasons]
      }];
    });
  }
  private compare(branchId: string, compareBranchId: string, aggregate: "hourly" | "daily", base: Array<Record<string, unknown>>, compare: Array<Record<string, unknown>>) {
    const compareByBucket = new Map(compare.map((row) => [String(row.bucket_ts), row]));
    const baseBuckets = new Set(base.map((row) => String(row.bucket_ts)));
    return {
      baseBranchId: branchId,
      compareBranchId,
      aggregate,
      points: [
        ...base.map((row) => {
          const other = compareByBucket.get(String(row.bucket_ts));
          return {
            bucket_ts: row.bucket_ts,
            base: row,
            compare: other ?? null,
            delta_avg: other ? asNumber(row.avg) - asNumber(other.avg) : null
          };
        }),
        ...compare.filter((row) => !baseBuckets.has(String(row.bucket_ts))).map((row) => ({
          bucket_ts: row.bucket_ts,
          base: null,
          compare: row,
          delta_avg: null
        }))
      ].sort((left, right) => String(left.bucket_ts).localeCompare(String(right.bucket_ts)))
    };
  }
}

type TraceStep = {
  order: number;
  kind: "book" | "rfid_tag" | "loan_transaction" | "device_event" | "camera_clip" | "alert" | "maintenance";
  ts: string | null;
  record: Record<string, unknown>;
};

export class TraceService {
  constructor(private readonly repo: LibraryRepository) {}
  query(input: TraceQuery) {
    const resolved = this.resolve(input);
    const book = resolved.book;
    const loan = resolved.loan;
    const rfidTag = String(book.rfid_tag);
    const window = this.window(book, loan, resolved.alert);
    const gateEvents = this.repo.gateEventsForTrace({
      branchId: window.branchId,
      rfidTag,
      from: window.from,
      to: window.to
    }) as Array<Record<string, unknown>>;
    const clips = this.clipEvidence(window.branchId, window.from, window.to);
    const clipIds = clips.map((clip) => String(clip.id));
    const alerts = this.relatedAlerts(window.branchId, loan ? String(loan.id) : undefined, clipIds, window.from, window.to, resolved.alert);
    const maintenance = this.repo.maintenanceForTrace(alerts.map((alert) => String(alert.id))) as Array<Record<string, unknown>>;
    const chain: TraceStep[] = [];
    chain.push({ order: chain.length + 1, kind: "book", ts: String(book.created_at ?? null), record: book });
    chain.push({ order: chain.length + 1, kind: "rfid_tag", ts: String(book.updated_at ?? book.created_at ?? null), record: { tag: rfidTag, book_id: book.id, branch_id: book.branch_id } });
    if (loan) chain.push({ order: chain.length + 1, kind: "loan_transaction", ts: String(loan.borrowed_at), record: this.loanRecord(loan) });
    if (loan?.device_id) chain.push({ order: chain.length + 1, kind: "device_event", ts: String(loan.borrowed_at), record: this.loanDeviceEvent(loan) });
    for (const event of gateEvents) chain.push({ order: chain.length + 1, kind: "device_event", ts: String(event.ts), record: this.gateRecord(event) });
    for (const clip of clips) chain.push({ order: chain.length + 1, kind: "camera_clip", ts: String(clip.start_ts), record: clip });
    for (const alert of alerts) chain.push({ order: chain.length + 1, kind: "alert", ts: String(alert.created_at), record: alert });
    for (const item of maintenance) chain.push({ order: chain.length + 1, kind: "maintenance", ts: String(item.started_at), record: item });
    return {
      input,
      window,
      chain: chain.map((step, index) => ({ ...step, order: index + 1 }))
    };
  }
  private resolve(input: TraceQuery) {
    if (input.alertId) {
      const alert = this.repo.alertDetail(input.alertId) as Record<string, unknown> | undefined;
      if (!alert) throw new DomainError("TRACE_NOT_FOUND", "Alert not found");
      const loan = alert.related_loan_id ? this.repo.loanDetail(String(alert.related_loan_id)) : undefined;
      if (!loan) throw new DomainError("TRACE_NOT_FOUND", "Alert is not linked to a loan trace");
      const book = this.repo.findBook(String(loan.book_id));
      if (!book) throw new DomainError("TRACE_NOT_FOUND", "Book not found for alert trace");
      return { book, loan, alert };
    }
    if (input.loanId) {
      const loan = this.repo.loanDetail(input.loanId);
      if (!loan) throw new DomainError("TRACE_NOT_FOUND", "Loan not found");
      const book = this.repo.findBook(String(loan.book_id));
      if (!book) throw new DomainError("TRACE_NOT_FOUND", "Book not found for loan trace");
      return { book, loan, alert: undefined };
    }
    if (input.book) {
      const book = this.repo.findBookForTrace(input.book);
      if (!book) throw new DomainError("TRACE_NOT_FOUND", "Book not found");
      return { book, loan: this.repo.latestLoanForBook(String(book.id)), alert: undefined };
    }
    throw new DomainError("TRACE_NOT_FOUND", "Provide book, loanId, or alertId");
  }
  private window(book: Record<string, unknown>, loan?: Record<string, unknown>, alert?: Record<string, unknown>) {
    const branchId = String(loan?.branch_id ?? alert?.branch_id ?? book.branch_id);
    const borrowedAt = loan?.borrowed_at ? String(loan.borrowed_at) : undefined;
    const returnedAt = loan?.returned_at ? String(loan.returned_at) : undefined;
    const alertAt = alert?.created_at ? String(alert.created_at) : undefined;
    const from = borrowedAt ?? alertAt ?? String(book.created_at);
    const to = returnedAt ?? alertAt ?? new Date().toISOString();
    return { branchId, from, to, source: loan ? "loan" : alert ? "alert" : "book" };
  }
  private clipEvidence(branchId: string, from: string, to: string) {
    const clips = this.repo.cameraClipsForTrace({ branchId, from, to }) as Array<Record<string, unknown>>;
    if (clips.length > 0) return clips;
    const nearest = this.repo.findNearestClip(branchId, from);
    return nearest ? [nearest] : [];
  }
  private relatedAlerts(branchId: string, loanId: string | undefined, clipIds: string[], from: string, to: string, alert?: Record<string, unknown>) {
    const alerts = this.repo.alertsForTrace({ branchId, loanId, clipIds, from, to }) as Array<Record<string, unknown>>;
    if (alert && !alerts.some((row) => row.id === alert.id)) return [...alerts, alert].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
    return alerts;
  }
  private loanRecord(loan: Record<string, unknown>) {
    return {
      ...loan,
      who: { user_id: loan.user_id, name: loan.user_name ?? null, account: loan.user_account ?? null },
      when: { borrowed_at: loan.borrowed_at, returned_at: loan.returned_at ?? null, due_at: loan.due_at }
    };
  }
  private loanDeviceEvent(loan: Record<string, unknown>) {
    return {
      id: `loan-device-${String(loan.id)}`,
      source: "loan",
      branch_id: loan.branch_id,
      device_id: loan.device_id,
      device_name: loan.device_name ?? null,
      device_kind: loan.device_kind ?? null,
      action: "borrow",
      ts: loan.borrowed_at
    };
  }
  private gateRecord(event: Record<string, unknown>) {
    return {
      ...event,
      rfid_tags: this.parseTags(event.rfid_tags_json)
    };
  }
  private parseTags(value: unknown) {
    try {
      return JSON.parse(String(value)) as string[];
    } catch {
      return [];
    }
  }
}

type ExportColumn = {
  key: string;
  en: string;
  zh: string;
  type?: "date" | "number" | "money";
};

const exportColumns: Record<ExportDataset, ExportColumn[]> = {
  loans: [
    { key: "id", en: "Loan ID", zh: "借阅编号" },
    { key: "branch_name", en: "Branch", zh: "分馆" },
    { key: "status", en: "Status", zh: "状态" },
    { key: "book_title", en: "Book Title", zh: "书名" },
    { key: "isbn", en: "ISBN", zh: "ISBN" },
    { key: "rfid_tag", en: "RFID Tag", zh: "RFID 标签" },
    { key: "reader_name", en: "Reader", zh: "读者" },
    { key: "device_name", en: "Device", zh: "设备" },
    { key: "borrowed_at", en: "Borrowed At", zh: "借出时间", type: "date" },
    { key: "due_at", en: "Due At", zh: "应还时间", type: "date" },
    { key: "returned_at", en: "Returned At", zh: "归还时间", type: "date" },
    { key: "renew_count", en: "Renew Count", zh: "续借次数", type: "number" }
  ],
  books: [
    { key: "id", en: "Book ID", zh: "图书编号" },
    { key: "isbn", en: "ISBN", zh: "ISBN" },
    { key: "title", en: "Title", zh: "书名" },
    { key: "author", en: "Author", zh: "作者" },
    { key: "category", en: "Category", zh: "分类" },
    { key: "branch_name", en: "Branch", zh: "分馆" },
    { key: "shelf_location", en: "Shelf", zh: "书架" },
    { key: "edition", en: "Edition", zh: "版本" },
    { key: "purchased_at", en: "Purchased At", zh: "采购时间", type: "date" },
    { key: "rfid_tag", en: "RFID Tag", zh: "RFID 标签" },
    { key: "status", en: "Status", zh: "状态" }
  ],
  readers: [
    { key: "id", en: "Reader ID", zh: "读者编号" },
    { key: "username", en: "Account", zh: "账号" },
    { key: "display_name", en: "Name", zh: "姓名" },
    { key: "email", en: "Email", zh: "邮箱" },
    { key: "student_no", en: "Student No.", zh: "学号" },
    { key: "card_no", en: "Card No.", zh: "卡号" },
    { key: "deposit_cents", en: "Deposit (cents)", zh: "押金(分)", type: "number" },
    { key: "loan_count", en: "Loan Count", zh: "借阅次数", type: "number" },
    { key: "status", en: "Status", zh: "状态" },
    { key: "created_at", en: "Created At", zh: "创建时间", type: "date" }
  ],
  telemetry: [
    { key: "id", en: "Sample ID", zh: "采样编号" },
    { key: "branch_name", en: "Branch", zh: "分馆" },
    { key: "device_name", en: "Device", zh: "设备" },
    { key: "metric", en: "Metric", zh: "指标" },
    { key: "value", en: "Value", zh: "数值", type: "number" },
    { key: "quality", en: "Quality", zh: "质量" },
    { key: "ts", en: "Timestamp", zh: "采样时间", type: "date" }
  ],
  alerts: [
    { key: "id", en: "Alert ID", zh: "告警编号" },
    { key: "branch_name", en: "Branch", zh: "分馆" },
    { key: "device_name", en: "Device", zh: "设备" },
    { key: "type", en: "Type", zh: "类型" },
    { key: "severity", en: "Severity", zh: "级别" },
    { key: "message", en: "Message", zh: "消息" },
    { key: "status", en: "Status", zh: "状态" },
    { key: "created_at", en: "Created At", zh: "创建时间", type: "date" },
    { key: "resolved_at", en: "Resolved At", zh: "解决时间", type: "date" }
  ],
  maintenance: [
    { key: "id", en: "Record ID", zh: "记录编号" },
    { key: "branch_name", en: "Branch", zh: "分馆" },
    { key: "device_name", en: "Device", zh: "设备" },
    { key: "kind", en: "Kind", zh: "类型" },
    { key: "description", en: "Description", zh: "描述" },
    { key: "status", en: "Status", zh: "状态" },
    { key: "started_at", en: "Started At", zh: "开始时间", type: "date" },
    { key: "finished_at", en: "Finished At", zh: "完成时间", type: "date" },
    { key: "related_alert_id", en: "Related Alert", zh: "关联告警" }
  ]
};

const sheetNames: Record<ExportLocale, Record<ExportDataset, string>> = {
  en: { loans: "Loans", books: "Books", readers: "Readers", telemetry: "Telemetry", alerts: "Alerts", maintenance: "Maintenance" },
  "zh-CN": { loans: "借阅", books: "图书", readers: "读者", telemetry: "遥测", alerts: "告警", maintenance: "维护" }
};

export class ExportService {
  constructor(private readonly repo: LibraryRepository) {}
  private exportRows(query: ExportQuery) {
    const rows = this.repo.exportRows(query) as Array<Record<string, unknown>>;
    return query.dataset === "readers" ? rows.map(maskUser) : rows;
  }
  preview(query: ExportQuery) {
    const locale = query.locale ?? "en";
    const rows = this.exportRows({ ...query, locale, limit: 20 }) as Array<Record<string, unknown>>;
    const columns = exportColumns[query.dataset].map((column) => ({ key: column.key, header: this.header(column, locale), type: column.type ?? "text" }));
    return {
      dataset: query.dataset,
      locale,
      filters: this.filters(query),
      columns,
      rows: rows.map((row) => this.project(row, exportColumns[query.dataset]))
    };
  }
  history(query?: Query) {
    return this.repo.exportHistory(query).map((row) => this.withParsedDetail(row as Record<string, unknown>));
  }
  async create(query: ExportQuery, actorId: string, ip?: string) {
    const locale = query.locale ?? "en";
    const rows = this.exportRows({ ...query, locale }) as Array<Record<string, unknown>>;
    const createdAt = new Date().toISOString();
    const fileName = `${query.dataset}-${createdAt.replace(/[:.]/g, "-")}.xlsx`;
    const history = this.repo.createExportHistory({
      dataset: query.dataset,
      locale,
      branch_id: query.branchId ?? null,
      from_ts: query.from ?? null,
      to_ts: query.to ?? null,
      row_count: rows.length,
      file_name: fileName,
      download_path: "",
      created_by: actorId,
      detail_json: JSON.stringify(this.filters(query))
    }) as Record<string, unknown>;
    const downloadPath = `/api/exports/${String(history.id)}/download`;
    const saved = this.repo.update("export_history", String(history.id), { download_path: downloadPath }) as Record<string, unknown>;
    this.repo.recordAudit({
      actor_id: actorId,
      action: "export_dataset",
      entity: "export",
      entity_id: String(history.id),
      detail_json: JSON.stringify({ dataset: query.dataset, locale, rowCount: rows.length, filters: this.filters(query) }),
      ip: ip ?? null
    });
    return { workbook: this.workbook({ ...query, locale }, rows, String(history.id), createdAt), history: this.withParsedDetail(saved), fileName };
  }
  async recreate(exportId: string, actorId: string, ip?: string) {
    const history = this.repo.exportHistoryById(exportId);
    if (!history) throw new DomainError("EXPORT_NOT_FOUND", "Export history record not found");
    const query: ExportQuery & { locale: ExportLocale } = {
      dataset: history.dataset as ExportDataset,
      locale: history.locale as ExportLocale,
      branchId: history.branch_id ? String(history.branch_id) : undefined,
      from: history.from_ts ? String(history.from_ts) : undefined,
      to: history.to_ts ? String(history.to_ts) : undefined
    };
    const rows = this.exportRows(query) as Array<Record<string, unknown>>;
    this.repo.recordAudit({
      actor_id: actorId,
      action: "download_export",
      entity: "export",
      entity_id: exportId,
      detail_json: JSON.stringify({ dataset: query.dataset, locale: query.locale, rowCount: rows.length, filters: this.filters(query) }),
      ip: ip ?? null
    });
    return {
      workbook: this.workbook(query, rows, exportId, String(history.created_at)),
      history: this.withParsedDetail(history),
      fileName: String(history.file_name)
    };
  }
  async toBuffer(workbook: ExcelJS.Workbook) {
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
  private workbook(query: ExportQuery & { locale: ExportLocale }, rows: Array<Record<string, unknown>>, exportId: string, createdAt: string) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Unmanned Library";
    workbook.created = new Date(createdAt);
    const columns = exportColumns[query.dataset];
    const dataSheet = workbook.addWorksheet(sheetNames[query.locale][query.dataset], { views: [{ state: "frozen", ySplit: 1 }] });
    dataSheet.columns = columns.map((column) => ({ key: column.key, header: this.header(column, query.locale), width: this.width(column) }));
    dataSheet.getRow(1).font = { bold: true };
    dataSheet.getRow(1).alignment = { vertical: "middle" };
    for (const row of rows) dataSheet.addRow(this.project(row, columns));
    columns.forEach((column, index) => {
      const excelColumn = dataSheet.getColumn(index + 1);
      if (column.type === "date") excelColumn.numFmt = "yyyy-mm-dd hh:mm:ss";
      if (column.type === "number") excelColumn.numFmt = "0";
      if (column.type === "money") excelColumn.numFmt = "0.00";
    });
    const summary = workbook.addWorksheet(query.locale === "zh-CN" ? "汇总" : "Summary");
    summary.columns = [
      { key: "field", header: query.locale === "zh-CN" ? "字段" : "Field", width: 24 },
      { key: "value", header: query.locale === "zh-CN" ? "值" : "Value", width: 48 }
    ];
    summary.views = [{ state: "frozen", ySplit: 1 }];
    summary.getRow(1).font = { bold: true };
    [
      ["exportId", exportId],
      ["dataset", query.dataset],
      ["locale", query.locale],
      ["branchId", query.branchId ?? ""],
      ["from", query.from ?? ""],
      ["to", query.to ?? ""],
      ["rowCount", rows.length],
      ["generatedAt", createdAt]
    ].forEach(([field, value]) => summary.addRow({ field, value }));
    return workbook;
  }
  private project(row: Record<string, unknown>, columns: ExportColumn[]) {
    return Object.fromEntries(columns.map((column) => [column.key, this.cell(row[column.key], column.type)]));
  }
  private cell(value: unknown, type?: ExportColumn["type"]) {
    if (value === null || value === undefined) return "";
    if (type === "date") {
      const parsed = new Date(String(value));
      return Number.isNaN(parsed.getTime()) ? String(value) : parsed;
    }
    if (type === "number" || type === "money") return Number(value);
    return value;
  }
  private header(column: ExportColumn, locale: ExportLocale) {
    return locale === "zh-CN" ? column.zh : column.en;
  }
  private width(column: ExportColumn) {
    if (column.type === "date") return 22;
    if (column.key.includes("message") || column.key.includes("description") || column.key.includes("title")) return 36;
    return 18;
  }
  private filters(query: ExportQuery) {
    return {
      branchId: query.branchId ?? null,
      from: query.from ?? null,
      to: query.to ?? null
    };
  }
  private withParsedDetail(row: Record<string, unknown>) {
    try {
      return { ...row, detail: JSON.parse(String(row.detail_json)) as unknown };
    } catch {
      return { ...row, detail: {} };
    }
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
    trace: new TraceService(repo),
    exports: new ExportService(repo),
    maintenance: new MaintenanceService(repo),
    circulation: new CirculationService(repo, bus),
    rules: new RuleService(repo),
    stats: { overview: () => repo.overview() }
  };
}
