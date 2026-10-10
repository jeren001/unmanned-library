import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.js";

export type Query = { limit?: number; offset?: number; status?: string; branchId?: string; userId?: string; q?: string };
export type AlertQuery = Query & { type?: string; severity?: string; from?: string; to?: string };
export type MaintenanceQuery = Query & { deviceId?: string; alertId?: string; kind?: string; from?: string; to?: string };

const now = () => new Date().toISOString();
const id = () => randomUUID();

export class LibraryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(table: string, query: Query = {}) {
    const allowed = new Set(["branches", "users", "books", "loans", "reservations", "devices", "alerts", "alert_notes", "maintenance_records", "camera_clips", "rules", "notifications", "audit_log"]);
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
    const payload = { ...values, updated_at: now(), id: recordId };
    const fields = Object.keys(values).map((key) => `${key} = @${key}`);
    fields.push("updated_at = @updated_at");
    this.db.prepare(`UPDATE ${table} SET ${fields.join(", ")} WHERE id = @id`).run(payload);
    return this.get(table, recordId);
  }

  delete(table: string, recordId: string) {
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(recordId);
  }

  findUserById(userId: string) { return this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Record<string, unknown> | undefined; }
  findUserByAccount(account: string) {
    return this.db.prepare("SELECT * FROM users WHERE username = ? OR email = ? OR card_no = ?").get(account, account, account) as Record<string, unknown> | undefined;
  }
  findBook(bookId: string) { return this.db.prepare("SELECT * FROM books WHERE id = ?").get(bookId) as Record<string, unknown> | undefined; }
  findActiveLoan(bookId: string) { return this.db.prepare("SELECT * FROM loans WHERE book_id = ? AND status IN ('active','overdue')").get(bookId) as Record<string, unknown> | undefined; }
  findLoanByIdempotency(key: string) { return this.db.prepare("SELECT * FROM loans WHERE idempotency_key = ?").get(key) as Record<string, unknown> | undefined; }
  count(table: string, where = "1=1", params: Record<string, unknown> = {}) { return (this.db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE ${where}`).get(params) as { count: number }).count; }
  recordAudit(values: Record<string, unknown>) { return this.insert("audit_log", { ...values, ts: values.ts ?? now() }); }
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
  telemetry(query: Query & { metric?: string; from?: string; to?: string }) {
    const where = ["branch_id = @branchId", "metric = @metric"];
    const params: Record<string, unknown> = { branchId: query.branchId, metric: query.metric };
    if (query.from) { where.push("ts >= @from"); params.from = query.from; }
    if (query.to) { where.push("ts <= @to"); params.to = query.to; }
    return this.db.prepare(`SELECT * FROM telemetry WHERE ${where.join(" AND ")} ORDER BY ts ASC LIMIT 1000`).all(params);
  }
  findNearestClip(branchId: string, ts: string) {
    return this.db.prepare(`
      SELECT * FROM camera_clips WHERE branch_id = ?
      ORDER BY ABS(strftime('%s', start_ts) - strftime('%s', ?)) ASC LIMIT 1
    `).get(branchId, ts) as Record<string, unknown> | undefined;
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
