import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.js";

export type Query = { limit?: number; offset?: number; status?: string; branchId?: string; userId?: string; q?: string };
export type AlertQuery = Query & { type?: string; severity?: string; from?: string; to?: string };
export type MaintenanceQuery = Query & { deviceId?: string; alertId?: string; kind?: string; from?: string; to?: string };
export type TelemetryAggregate = "raw" | "hourly" | "daily";
export type TelemetryMode = "raw" | "cleaned";
export type TelemetryQuery = {
  branchId: string;
  metric: string;
  from?: string;
  to?: string;
  aggregate?: TelemetryAggregate;
  mode?: TelemetryMode;
  compareBranchId?: string;
};
export type TraceQuery = {
  book?: string;
  loanId?: string;
  alertId?: string;
};
export type ExportDataset = "loans" | "books" | "readers" | "telemetry" | "alerts" | "maintenance";
export type ExportLocale = "en" | "zh-CN";
export type ExportQuery = {
  dataset: ExportDataset;
  locale?: ExportLocale;
  branchId?: string;
  from?: string;
  to?: string;
  limit?: number;
};

const now = () => new Date().toISOString();
const appendOnlyTables = new Set(["audit_log"]);
const assertMutable = (table: string) => {
  if (appendOnlyTables.has(table)) throw new Error(`${table} is append-only`);
};
const id = () => randomUUID();

export class LibraryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(table: string, query: Query = {}) {
    const allowed = new Set(["branches", "users", "books", "loans", "reservations", "devices", "alerts", "alert_notes", "maintenance_records", "camera_clips", "rules", "notifications", "audit_log", "export_history"]);
    if (!allowed.has(table)) throw new Error("Unsupported table");
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.status) { where.push("status = @status"); params.status = query.status; }
    if (query.branchId && table !== "users" && table !== "rules") { where.push("branch_id = @branchId"); params.branchId = query.branchId; }
    if (query.userId && ["loans", "reservations"].includes(table)) { where.push("user_id = @userId"); params.userId = query.userId; }
    if (query.q && ["books", "users", "devices"].includes(table)) {
      const fields = table === "books" ? ["title", "author", "isbn", "rfid_tag"] : table === "users" ? ["display_name", "username", "email", "card_no"] : ["name", "kind", "address"];
      where.push(`(${fields.map((field) => `${field} LIKE @q`).join(" OR ")})`);
      params.q = `%${query.q}%`;
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const sql = `SELECT * FROM ${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`;
    return this.db.prepare(sql).all({ ...params, limit, offset });
  }

  get(table: string, recordId: string) {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(recordId);
  }

  insert(table: string, values: Record<string, unknown>) {
    const columns = Object.keys(values);
    const payload = { ...values, id: values.id ?? id(), created_at: values.created_at ?? now(), updated_at: values.updated_at ?? now() };
    const names = Object.keys(payload);
    const placeholders = names.map((name) => `@${name}`);
    this.db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${placeholders.join(",")})`).run(payload);
    return this.get(table, String(payload.id));
  }

  update(table: string, recordId: string, values: Record<string, unknown>) {
    assertMutable(table);
    const payload = { ...values, updated_at: now(), id: recordId };
    const fields = Object.keys(values).map((key) => `${key} = @${key}`);
    fields.push("updated_at = @updated_at");
    this.db.prepare(`UPDATE ${table} SET ${fields.join(", ")} WHERE id = @id`).run(payload);
    return this.get(table, recordId);
  }

  delete(table: string, recordId: string) {
    assertMutable(table);
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(recordId);
  }

  findUserById(userId: string) { return this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Record<string, unknown> | undefined; }
  findUserByAccount(account: string) {
    return this.db.prepare("SELECT * FROM users WHERE username = ? OR email = ? OR card_no = ?").get(account, account, account) as Record<string, unknown> | undefined;
  }
  findBook(bookId: string) { return this.db.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as Record<string, unknown> | undefined; }
  findBookForTrace(input: string) {
    return this.db.prepare(`
      SELECT * FROM books
      WHERE id = @input OR isbn = @input OR rfid_tag = @input OR title = @input
      ORDER BY updated_at DESC LIMIT 1
    `).get({ input }) as Record<string, unknown> | undefined
      ?? this.db.prepare("SELECT * FROM books WHERE title LIKE @q ORDER BY updated_at DESC LIMIT 1").get({ q: `%${input}%` }) as Record<string, unknown> | undefined;
  }
  findActiveLoan(bookId: string) { return this.db.prepare("SELECT * FROM loans WHERE book_id = ? AND status IN ('active','overdue')").get(bookId) as Record<string, unknown> | undefined; }
  findLoanByIdempotency(key: string) { return this.db.prepare("SELECT * FROM loans WHERE idempotency_key = ?").get(key) as Record<string, unknown> | undefined; }
  count(table: string, where = "1=1", params: Record<string, unknown> = {}) { return (this.db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE ${where}`).get(params) as { count: number }).count; }
  recordAudit(values: Record<string, unknown>) { return this.insert("audit_log", { ...values, ts: values.ts ?? now() }); }
  createExportHistory(values: Record<string, unknown>) { return this.insert("export_history", values); }
  exportHistory(query: Query = {}) {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    return this.db.prepare(`
      SELECT export_history.*, users.display_name AS created_by_name
      FROM export_history
      LEFT JOIN users ON users.id = export_history.created_by
      ORDER BY export_history.created_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ limit, offset });
  }
  exportHistoryById(exportId: string) {
    return this.db.prepare("SELECT * FROM export_history WHERE id = ?").get(exportId) as Record<string, unknown> | undefined;
  }
  exportRows(query: ExportQuery) {
    const params: Record<string, unknown> = {};
    const limit = query.limit ? Math.min(Math.max(query.limit, 1), 10_000) : undefined;
    const applyLimit = (sql: string) => `${sql}${limit ? " LIMIT @limit" : ""}`;
    if (limit) params.limit = limit;
    const addRange = (where: string[], column: string) => {
      if (query.branchId) { where.push(`${column.startsWith("users.") ? "EXISTS (SELECT 1 FROM loans WHERE loans.user_id = users.id AND loans.branch_id = @branchId)" : `${column.split(".")[0]}.branch_id = @branchId`}`); params.branchId = query.branchId; }
      if (query.from) { where.push(`${column} >= @from`); params.from = query.from; }
      if (query.to) { where.push(`${column} <= @to`); params.to = query.to; }
    };
    if (query.dataset === "loans") {
      const where: string[] = [];
      addRange(where, "loans.borrowed_at");
      return this.db.prepare(applyLimit(`
        SELECT loans.id, loans.branch_id, branches.name_en AS branch_name, loans.status, loans.book_id,
          books.title AS book_title, books.isbn, books.rfid_tag, loans.user_id, users.display_name AS reader_name,
          loans.device_id, devices.name AS device_name, loans.borrowed_at, loans.due_at, loans.returned_at,
          loans.renew_count, loans.created_at
        FROM loans
        LEFT JOIN branches ON branches.id = loans.branch_id
        LEFT JOIN books ON books.id = loans.book_id
        LEFT JOIN users ON users.id = loans.user_id
        LEFT JOIN devices ON devices.id = loans.device_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY loans.borrowed_at DESC
      `)).all(params);
    }
    if (query.dataset === "books") {
      const where: string[] = [];
      addRange(where, "books.created_at");
      return this.db.prepare(applyLimit(`
        SELECT books.id, books.isbn, books.title, books.author, books.category, books.branch_id,
          branches.name_en AS branch_name, books.shelf_location, books.edition, books.purchased_at,
          books.rfid_tag, books.status, books.created_at, books.updated_at
        FROM books
        LEFT JOIN branches ON branches.id = books.branch_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY books.created_at DESC
      `)).all(params);
    }
    if (query.dataset === "readers") {
      const where = ["users.role = 'reader'"];
      addRange(where, "users.created_at");
      return this.db.prepare(applyLimit(`
        SELECT users.id, users.username, users.email, users.display_name, users.student_no,
          users.card_no, users.deposit_cents, users.status, users.locked_until, users.created_at,
          users.updated_at, COUNT(loans.id) AS loan_count
        FROM users
        LEFT JOIN loans ON loans.user_id = users.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        GROUP BY users.id
        ORDER BY users.created_at DESC
      `)).all(params);
    }
    if (query.dataset === "telemetry") {
      const where: string[] = [];
      addRange(where, "telemetry.ts");
      return this.db.prepare(applyLimit(`
        SELECT telemetry.id, telemetry.branch_id, branches.name_en AS branch_name, telemetry.device_id,
          devices.name AS device_name, telemetry.metric, telemetry.value, telemetry.quality,
          telemetry.ts, telemetry.created_at
        FROM telemetry
        LEFT JOIN branches ON branches.id = telemetry.branch_id
        LEFT JOIN devices ON devices.id = telemetry.device_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY telemetry.ts DESC
      `)).all(params);
    }
    if (query.dataset === "alerts") {
      const where: string[] = [];
      addRange(where, "alerts.created_at");
      return this.db.prepare(applyLimit(`
        SELECT alerts.id, alerts.branch_id, branches.name_en AS branch_name, alerts.device_id,
          devices.name AS device_name, alerts.type, alerts.severity, alerts.message, alerts.status,
          alerts.created_at, alerts.acked_by, alerts.resolved_at, alerts.related_loan_id, alerts.related_clip_id
        FROM alerts
        LEFT JOIN branches ON branches.id = alerts.branch_id
        LEFT JOIN devices ON devices.id = alerts.device_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY alerts.created_at DESC
      `)).all(params);
    }
    const where: string[] = [];
    addRange(where, "maintenance_records.started_at");
    return this.db.prepare(applyLimit(`
      SELECT maintenance_records.id, maintenance_records.branch_id, branches.name_en AS branch_name,
        maintenance_records.device_id, devices.name AS device_name, maintenance_records.kind,
        maintenance_records.description, maintenance_records.started_at, maintenance_records.finished_at,
        maintenance_records.operator_id, maintenance_records.related_alert_id,
        CASE WHEN maintenance_records.finished_at IS NULL THEN 'open' ELSE 'completed' END AS status,
        maintenance_records.created_at
      FROM maintenance_records
      LEFT JOIN branches ON branches.id = maintenance_records.branch_id
      LEFT JOIN devices ON devices.id = maintenance_records.device_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY maintenance_records.started_at DESC
    `)).all(params);
  }
  upsertRule(key: string, value: unknown, description: string) { return this.db.prepare("INSERT INTO rules(key,value_json,description) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,description=excluded.description,updated_at=CURRENT_TIMESTAMP").run(key, JSON.stringify(value), description); }
  getRules() { return this.db.prepare("SELECT * FROM rules ORDER BY key").all(); }
  latestRuleAudit() {
    return this.db.prepare(`
      SELECT audit_log.*, users.display_name AS actor_name
      FROM audit_log LEFT JOIN users ON users.id = audit_log.actor_id
      WHERE action = 'update_rule'
      ORDER BY ts DESC LIMIT 1
    `).get();
  }
  ingestTelemetry(values: Record<string, unknown>) {
    const result = this.insert("telemetry", values);
    const row = values as { branch_id: string; metric: string; value: number; ts: string };
    const hour = row.ts.slice(0, 13) + ":00:00.000Z";
    this.db.prepare(`
      INSERT INTO telemetry_hourly(branch_id,metric,hour_ts,avg,min,max,count)
      VALUES (@branch_id,@metric,@hour_ts,@value,@value,@value,1)
      ON CONFLICT(branch_id,metric,hour_ts) DO UPDATE SET
        avg=((telemetry_hourly.avg*telemetry_hourly.count)+excluded.avg)/(telemetry_hourly.count+1),
        min=MIN(telemetry_hourly.min,excluded.min),
        max=MAX(telemetry_hourly.max,excluded.max),
        count=telemetry_hourly.count+1
    `).run({ ...row, hour_ts: hour });
    return result;
  }
  rollupTelemetry() {
    this.db.exec(`
      INSERT INTO telemetry_hourly(branch_id, metric, hour_ts, avg, min, max, count)
      SELECT branch_id, metric, substr(ts, 1, 13) || ':00:00.000Z', avg(value), min(value), max(value), count(*)
      FROM telemetry GROUP BY branch_id, metric, substr(ts, 1, 13)
      ON CONFLICT(branch_id, metric, hour_ts) DO UPDATE SET
        avg=excluded.avg, min=excluded.min, max=excluded.max, count=excluded.count
    `);
  }
  archiveTelemetryBefore(cutoff: string) {
    const archive = this.db.transaction(() => {
      // Refresh rollups for the archived hours from the raw rows before they leave `telemetry`.
      this.db.prepare(`
        INSERT INTO telemetry_hourly(branch_id, metric, hour_ts, avg, min, max, count)
        SELECT branch_id, metric, substr(ts, 1, 13) || ':00:00.000Z', avg(value), min(value), max(value), count(*)
        FROM telemetry WHERE ts < @cutoff GROUP BY branch_id, metric, substr(ts, 1, 13)
        ON CONFLICT(branch_id, metric, hour_ts) DO UPDATE SET
          avg=excluded.avg, min=excluded.min, max=excluded.max, count=excluded.count
      `).run({ cutoff });
      this.db.prepare(`
        INSERT INTO telemetry_archive(id, device_id, branch_id, metric, value, quality, ts, created_at, updated_at, archived_at)
        SELECT id, device_id, branch_id, metric, value, quality, ts, created_at, updated_at, @archivedAt
        FROM telemetry WHERE ts < @cutoff
      `).run({ cutoff, archivedAt: now() });
      return this.db.prepare("DELETE FROM telemetry WHERE ts < @cutoff").run({ cutoff }).changes;
    });
    return archive();
  }
  telemetry(query: Query & { metric?: string; from?: string; to?: string }) {
    const where = ["branch_id = @branchId", "metric = @metric"];
    const params: Record<string, unknown> = { branchId: query.branchId, metric: query.metric };
    if (query.from) { where.push("ts >= @from"); params.from = query.from; }
    if (query.to) { where.push("ts <= @to"); params.to = query.to; }
    return this.db.prepare(`SELECT * FROM telemetry WHERE ${where.join(" AND ")} ORDER BY ts ASC LIMIT 1000`).all(params);
  }
  telemetryRows(query: TelemetryQuery) {
    const { where, params } = this.telemetryWhere(query);
    return this.db.prepare(`SELECT * FROM telemetry WHERE ${where.join(" AND ")} ORDER BY ts ASC LIMIT 1000`).all(params);
  }
  telemetryAggregate(query: TelemetryQuery) {
    const { where, params } = this.telemetryWhere(query);
    const bucket = query.aggregate === "daily"
      ? "substr(ts, 1, 10) || 'T00:00:00.000Z'"
      : "substr(ts, 1, 13) || ':00:00.000Z'";
    return this.db.prepare(`
      SELECT ${bucket} AS bucket_ts,
        avg(value) AS avg,
        min(value) AS min,
        max(value) AS max,
        count(*) AS count,
        sum(CASE WHEN quality = 'suspect' THEN 1 ELSE 0 END) AS suspect_count,
        sum(CASE WHEN quality = 'dirty' THEN 1 ELSE 0 END) AS dirty_count
      FROM telemetry
      WHERE ${where.join(" AND ")}
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC
      LIMIT 1000
    `).all(params);
  }
  telemetryBranchAggregate(query: TelemetryQuery, branchId: string) {
    return this.telemetryAggregate({ ...query, branchId });
  }
  private telemetryWhere(query: TelemetryQuery) {
    const where = ["branch_id = @branchId", "metric = @metric"];
    const params: Record<string, unknown> = { branchId: query.branchId, metric: query.metric };
    if (query.from) { where.push("ts >= @from"); params.from = query.from; }
    if (query.to) { where.push("ts <= @to"); params.to = query.to; }
    if (query.mode === "cleaned") where.push("quality = 'ok'");
    return { where, params };
  }
  findNearestClip(branchId: string, ts: string) {
    return this.db.prepare(`
      SELECT * FROM camera_clips WHERE branch_id = ?
      ORDER BY ABS(strftime('%s', start_ts) - strftime('%s', ?)) ASC LIMIT 1
    `).get(branchId, ts) as Record<string, unknown> | undefined;
  }
  latestLoanForBook(bookId: string) {
    return this.db.prepare(`
      SELECT loans.*, users.display_name AS user_name, users.username AS user_account, devices.name AS device_name, devices.kind AS device_kind
      FROM loans
      LEFT JOIN users ON users.id = loans.user_id
      LEFT JOIN devices ON devices.id = loans.device_id
      WHERE loans.book_id = ?
      ORDER BY loans.borrowed_at DESC LIMIT 1
    `).get(bookId) as Record<string, unknown> | undefined;
  }
  loanDetail(loanId: string) {
    return this.db.prepare(`
      SELECT loans.*, users.display_name AS user_name, users.username AS user_account, devices.name AS device_name, devices.kind AS device_kind
      FROM loans
      LEFT JOIN users ON users.id = loans.user_id
      LEFT JOIN devices ON devices.id = loans.device_id
      WHERE loans.id = ?
    `).get(loanId) as Record<string, unknown> | undefined;
  }
  gateEventsForTrace(input: { branchId: string; rfidTag: string; from: string; to: string }) {
    return this.db.prepare(`
      SELECT gate_events.*, devices.name AS device_name, devices.kind AS device_kind
      FROM gate_events
      LEFT JOIN devices ON devices.id = gate_events.device_id
      WHERE gate_events.branch_id = @branchId
        AND gate_events.ts >= @from
        AND gate_events.ts <= @to
        AND gate_events.rfid_tags_json LIKE @rfid
      ORDER BY gate_events.ts ASC
      LIMIT 100
    `).all({ ...input, rfid: `%${input.rfidTag}%` });
  }
  cameraClipsForTrace(input: { branchId: string; from: string; to: string }) {
    return this.db.prepare(`
      SELECT camera_clips.*, devices.name AS device_name
      FROM camera_clips
      LEFT JOIN devices ON devices.id = camera_clips.device_id
      WHERE camera_clips.branch_id = @branchId
        AND camera_clips.start_ts <= @to
        AND camera_clips.end_ts >= @from
      ORDER BY camera_clips.start_ts ASC
      LIMIT 20
    `).all(input);
  }
  insertGateEvent(values: Record<string, unknown>) {
    return this.insert("gate_events", values);
  }
  findOpenAlert(dedupKey: string, since: string) {
    return this.db.prepare(`
      SELECT * FROM alerts
      WHERE status = 'open' AND created_at >= ? AND message LIKE ?
      ORDER BY created_at DESC LIMIT 1
    `).get(since, `%${dedupKey}%`) as Record<string, unknown> | undefined;
  }
  alertList(query: AlertQuery = {}) {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.branchId) { where.push("alerts.branch_id = @branchId"); params.branchId = query.branchId; }
    if (query.status) { where.push("alerts.status = @status"); params.status = query.status; }
    if (query.type) { where.push("alerts.type = @type"); params.type = query.type; }
    if (query.severity) { where.push("alerts.severity = @severity"); params.severity = query.severity; }
    if (query.from) { where.push("alerts.created_at >= @from"); params.from = query.from; }
    if (query.to) { where.push("alerts.created_at <= @to"); params.to = query.to; }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    return this.db.prepare(`
      SELECT alerts.*, devices.name AS device_name, branches.name_en AS branch_name
      FROM alerts
      LEFT JOIN devices ON devices.id = alerts.device_id
      LEFT JOIN branches ON branches.id = alerts.branch_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY alerts.created_at DESC LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });
  }
  alertDetail(alertId: string) {
    return this.db.prepare(`
      SELECT alerts.*, devices.name AS device_name, branches.name_en AS branch_name, camera_clips.file_path AS related_clip_path
      FROM alerts
      LEFT JOIN devices ON devices.id = alerts.device_id
      LEFT JOIN branches ON branches.id = alerts.branch_id
      LEFT JOIN camera_clips ON camera_clips.id = alerts.related_clip_id
      WHERE alerts.id = ?
    `).get(alertId) as Record<string, unknown> | undefined;
  }
  alertsForTrace(input: { branchId: string; loanId?: string; clipIds: string[]; from: string; to: string }) {
    const where = ["alerts.branch_id = @branchId"];
    const params: Record<string, unknown> = { branchId: input.branchId, from: input.from, to: input.to };
    const related: string[] = ["(alerts.created_at >= @from AND alerts.created_at <= @to)"];
    if (input.loanId) { related.push("alerts.related_loan_id = @loanId"); params.loanId = input.loanId; }
    input.clipIds.forEach((clipId, index) => {
      const key = `clipId${index}`;
      related.push(`alerts.related_clip_id = @${key}`);
      params[key] = clipId;
    });
    where.push(`(${related.join(" OR ")})`);
    return this.db.prepare(`
      SELECT alerts.*, devices.name AS device_name, branches.name_en AS branch_name, camera_clips.file_path AS related_clip_path
      FROM alerts
      LEFT JOIN devices ON devices.id = alerts.device_id
      LEFT JOIN branches ON branches.id = alerts.branch_id
      LEFT JOIN camera_clips ON camera_clips.id = alerts.related_clip_id
      WHERE ${where.join(" AND ")}
      ORDER BY alerts.created_at ASC
      LIMIT 100
    `).all(params);
  }
  alertTimeline(alertId: string) {
    const alert = this.get("alerts", alertId) as Record<string, unknown> | undefined;
    if (!alert) return [];
    const events = [
      { kind: "created", actor_id: null, message: alert.message, ts: alert.created_at },
      ...(alert.acked_by ? [{ kind: "acked", actor_id: alert.acked_by, message: "Alert acknowledged", ts: alert.updated_at }] : []),
      ...(alert.resolved_at ? [{ kind: "resolved", actor_id: null, message: "Alert resolved", ts: alert.resolved_at }] : [])
    ];
    const notes = this.db.prepare(`
      SELECT 'note' AS kind, actor_id, note AS message, created_at AS ts
      FROM alert_notes WHERE alert_id = ?
    `).all(alertId) as Array<{ kind: string; actor_id: string | null; message: string; ts: string }>;
    return [...events, ...notes].sort((left, right) => String(left.ts).localeCompare(String(right.ts)));
  }
  findRecentOpenAlert(input: { branchId: string; deviceId?: string | null; type: string; since: string }) {
    return this.db.prepare(`
      SELECT * FROM alerts
      WHERE status = 'open'
        AND branch_id = @branchId
        AND type = @type
        AND created_at >= @since
        AND ((@deviceId IS NULL AND device_id IS NULL) OR device_id = @deviceId)
      ORDER BY created_at DESC LIMIT 1
    `).get({ ...input, deviceId: input.deviceId ?? null }) as Record<string, unknown> | undefined;
  }
  maintenanceList(query: MaintenanceQuery = {}) {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.branchId) { where.push("maintenance_records.branch_id = @branchId"); params.branchId = query.branchId; }
    if (query.deviceId) { where.push("maintenance_records.device_id = @deviceId"); params.deviceId = query.deviceId; }
    if (query.alertId) { where.push("maintenance_records.related_alert_id = @alertId"); params.alertId = query.alertId; }
    if (query.kind) { where.push("maintenance_records.kind = @kind"); params.kind = query.kind; }
    if (query.status === "open") where.push("maintenance_records.finished_at IS NULL");
    if (query.status === "completed") where.push("maintenance_records.finished_at IS NOT NULL");
    if (query.from) { where.push("COALESCE(maintenance_records.finished_at, maintenance_records.started_at) >= @from"); params.from = query.from; }
    if (query.to) { where.push("maintenance_records.started_at <= @to"); params.to = query.to; }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    return this.db.prepare(`
      SELECT maintenance_records.*,
        branches.name_en AS branch_name,
        devices.name AS device_name,
        alerts.type AS alert_type,
        CASE WHEN maintenance_records.finished_at IS NULL THEN 'open' ELSE 'completed' END AS status
      FROM maintenance_records
      LEFT JOIN branches ON branches.id = maintenance_records.branch_id
      LEFT JOIN devices ON devices.id = maintenance_records.device_id
      LEFT JOIN alerts ON alerts.id = maintenance_records.related_alert_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY maintenance_records.started_at DESC, maintenance_records.created_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });
  }
  maintenanceForTrace(alertIds: string[]) {
    if (alertIds.length === 0) return [];
    const params = Object.fromEntries(alertIds.map((alertId, index) => [`alertId${index}`, alertId]));
    const placeholders = alertIds.map((_alertId, index) => `@alertId${index}`).join(",");
    return this.db.prepare(`
      SELECT maintenance_records.*,
        branches.name_en AS branch_name,
        devices.name AS device_name,
        alerts.type AS alert_type,
        CASE WHEN maintenance_records.finished_at IS NULL THEN 'open' ELSE 'completed' END AS status
      FROM maintenance_records
      LEFT JOIN branches ON branches.id = maintenance_records.branch_id
      LEFT JOIN devices ON devices.id = maintenance_records.device_id
      LEFT JOIN alerts ON alerts.id = maintenance_records.related_alert_id
      WHERE maintenance_records.related_alert_id IN (${placeholders})
      ORDER BY maintenance_records.started_at ASC, maintenance_records.created_at ASC
      LIMIT 100
    `).all(params);
  }
  maintenanceTimeline(days = 30, query: Pick<MaintenanceQuery, "branchId" | "deviceId"> = {}) {
    const safeDays = Math.min(Math.max(Math.trunc(days), 1), 365);
    const from = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
    return this.maintenanceList({ ...query, from, limit: 200, offset: 0 });
  }
  overview() {
    return {
      branches: this.count("branches"),
      books: this.count("books"),
      readers: this.count("users", "role = 'reader'"),
      devicesOnline: this.count("devices", "status = 'online'"),
      activeLoans: this.count("loans", "status IN ('active','overdue')"),
      openAlerts: this.count("alerts", "status = 'open'")
    };
  }
}
