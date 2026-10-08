import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.js";

export type Query = { limit?: number; offset?: number; status?: string; branchId?: string; userId?: string; q?: string };

const now = () => new Date().toISOString();
const id = () => randomUUID();

export class LibraryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(table: string, query: Query = {}) {
    const allowed = new Set(["branches", "users", "books", "loans", "reservations", "devices", "alerts", "maintenance_records", "camera_clips", "rules", "notifications", "audit_log"]);
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
