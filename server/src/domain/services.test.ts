import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { createDatabase } from "../persistence/database.js";
import { LibraryRepository } from "../persistence/repositories.js";
import { createDomainServices } from "./services.js";

function fixture() {
  const db = createDatabase(":memory:");
  const repo = new LibraryRepository(db);
  repo.insert("branches", { id: "branch-1", code: "T1", name_zh: "测试馆", name_en: "Test Library", type: "campus", address: "Test", status: "active" });
  repo.insert("branches", { id: "branch-2", code: "T2", name_zh: "对照馆", name_en: "Compare Library", type: "campus", address: "Test 2", status: "active" });
  repo.insert("users", { id: "admin-1", role: "admin", username: "admin", email: "admin@test", password_hash: "hash", display_name: "Admin", status: "active", locked_until: null });
  repo.insert("users", { id: "reader-1", role: "reader", username: "reader", email: "reader@test", password_hash: "hash", display_name: "Test Reader", student_no: "1", id_number_masked: "****", card_no: "CARD-1", qr_code: "QR-1", deposit_cents: 0, status: "active", locked_until: null });
  repo.insert("books", { id: "book-1", isbn: "978-1", title: "Test Book", author: "Test Author", category: "I247", branch_id: "branch-1", shelf_location: "A-01", edition: "1", purchased_at: "2026-01-01", rfid_tag: "RFID-1", status: "on_shelf", cover_color: "#1F4D3A" });
  repo.insert("devices", { id: "device-1", branch_id: "branch-1", kind: "kiosk", name: "Kiosk", vendor: "Mock", protocol: "mock", address: "mock://1", status: "online", last_seen_at: new Date().toISOString(), config_json: "{}" });
  repo.insert("devices", { id: "device-2", branch_id: "branch-2", kind: "kiosk", name: "Compare Kiosk", vendor: "Mock", protocol: "mock", address: "mock://2", status: "online", last_seen_at: new Date().toISOString(), config_json: "{}" });
  repo.upsertRule("loan_days", 30, "Loan days");
  repo.upsertRule("max_loans", 8, "Max loans");
  repo.upsertRule("max_renewals", 2, "Max renewals");
  return { db, repo, services: createDomainServices(repo) };
}

describe("CirculationService", () => {
  it("borrows idempotently and transitions the book", () => {
    const { db, repo, services } = fixture();
    const input = { bookId: "book-1", userId: "reader-1", branchId: "branch-1", deviceId: "device-1", idempotencyKey: "idem-1" };
    const first = services.circulation.borrow(input) as { id: string };
    const second = services.circulation.borrow(input) as { id: string };
    expect(second.id).toBe(first.id);
    expect(repo.findBook("book-1")?.status).toBe("borrowed");
    const renewed = services.circulation.renew({ loanId: first.id }) as { renew_count: number };
    expect(renewed.renew_count).toBe(1);
    services.circulation.returnLoan({ loanId: first.id });
    expect(repo.findBook("book-1")?.status).toBe("on_shelf");
    db.close();
  });

  it("rejects borrowing a borrowed book", () => {
    const { db, services } = fixture();
    services.circulation.borrow({ bookId: "book-1", userId: "reader-1", idempotencyKey: "idem-1" });
    expect(() => services.circulation.borrow({ bookId: "book-1", userId: "reader-1", idempotencyKey: "idem-2" })).toThrow("Book is not available");
    db.close();
  });

  it("blocks renewal when another reader has an active reservation", () => {
    const { db, repo, services } = fixture();
    const loan = services.circulation.borrow({ bookId: "book-1", userId: "reader-1", idempotencyKey: "idem-reserved" }) as { id: string };
    repo.insert("users", { id: "reader-2", role: "reader", username: "reader2", email: "reader2@test", password_hash: "hash", display_name: "Second Reader", status: "active" });
    repo.insert("reservations", { book_id: "book-1", user_id: "reader-2", expires_at: new Date(Date.now() + 86400000).toISOString(), status: "active" });
    expect(() => services.circulation.renew({ loanId: loan.id })).toThrow("reserved by another reader");
    db.close();
  });
});

describe("TelemetryService", () => {
  it("flags outliers and maintains an hourly rollup", () => {
    const { db, repo, services } = fixture();
    const normal = services.telemetry.ingest({ deviceId: "device-1", branchId: "branch-1", metric: "temperature", value: 24, ts: "2026-10-07T09:12:00.000Z" });
    const dirty = services.telemetry.ingest({ deviceId: "device-1", branchId: "branch-1", metric: "temperature", value: 999999, ts: "2026-10-07T09:24:00.000Z" });
    expect((normal as { quality: string }).quality).toBe("ok");
    expect((dirty as { quality: string }).quality).toBe("dirty");
    const hourly = db.prepare("SELECT count, min, max FROM telemetry_hourly WHERE branch_id='branch-1' AND metric='temperature'").get() as { count: number; min: number; max: number };
    expect(hourly.count).toBe(2);
    expect(hourly.min).toBe(24);
    expect(hourly.max).toBe(999999);
    expect(repo.telemetry({ branchId: "branch-1", metric: "temperature" })).toHaveLength(2);
    db.close();
  });

  it("archives only telemetry older than two years and keeps hourly rollups", () => {
    const { db, services } = fixture();
    const ingest = (ts: string, value: number) => services.telemetry.ingest({ deviceId: "device-1", branchId: "branch-1", metric: "temperature", value, ts });
    ingest("2023-05-01T08:10:00.000Z", 20);
    ingest("2023-05-01T08:40:00.000Z", 22);
    ingest("2024-10-11T11:59:00.000Z", 21);
    ingest("2024-10-11T12:05:00.000Z", 23);
    ingest("2026-10-11T09:00:00.000Z", 24);

    const result = services.telemetry.archive({ now: new Date("2026-10-11T12:30:00.000Z") });

    expect(result).toEqual({ moved: 3, cutoff: "2024-10-11T12:00:00.000Z" });
    const ids = (table: string) => (db.prepare(`SELECT ts FROM ${table} ORDER BY ts`).all() as Array<{ ts: string }>).map((row) => row.ts);
    expect(ids("telemetry_archive")).toEqual(["2023-05-01T08:10:00.000Z", "2023-05-01T08:40:00.000Z", "2024-10-11T11:59:00.000Z"]);
    expect(ids("telemetry")).toEqual(["2024-10-11T12:05:00.000Z", "2026-10-11T09:00:00.000Z"]);
    const oldHour = db.prepare("SELECT avg, min, max, count FROM telemetry_hourly WHERE hour_ts = '2023-05-01T08:00:00.000Z'").get();
    expect(oldHour).toEqual({ avg: 21, min: 20, max: 22, count: 2 });
    expect(db.prepare("SELECT count(*) AS count FROM telemetry_hourly").get()).toEqual({ count: 4 });
    expect(services.telemetry.archive({ now: new Date("2026-10-11T12:30:00.000Z") }).moved).toBe(0);
    db.close();
  });

  it("queries hourly and daily telemetry, reports anomalies, supports cleaned mode, and compares branches", () => {
    const { db, repo, services } = fixture();
    const staleTs = "2026-10-07T12:00:00.000Z";
    services.telemetry.ingest({ deviceId: "device-1", branchId: "branch-1", metric: "temperature", value: 22, ts: "2026-10-07T09:10:00.000Z" });
    services.telemetry.ingest({ deviceId: "device-1", branchId: "branch-1", metric: "temperature", value: 55, ts: "2026-10-07T09:20:00.000Z" });
    repo.ingestTelemetry({ device_id: "device-1", branch_id: "branch-1", metric: "temperature", value: 80, quality: "suspect", ts: "2026-10-07T10:00:00.000Z" });
    repo.ingestTelemetry({ device_id: "device-1", branch_id: "branch-1", metric: "temperature", value: 999999, quality: "dirty", ts: "2026-10-07T11:00:00.000Z" });
    repo.ingestTelemetry({ device_id: "device-1", branch_id: "branch-1", metric: "temperature", value: 21, quality: "suspect", ts: staleTs });
    services.telemetry.ingest({ deviceId: "device-2", branchId: "branch-2", metric: "temperature", value: 20, ts: "2026-10-07T09:00:00.000Z" });
    services.telemetry.ingest({ deviceId: "device-2", branchId: "branch-2", metric: "temperature", value: 24, ts: "2026-10-07T10:00:00.000Z" });

    const hourly = services.telemetry.query({
      branchId: "branch-1",
      metric: "temperature",
      from: "2026-10-07T00:00:00.000Z",
      to: "2026-10-08T00:00:00.000Z",
      aggregate: "hourly",
      mode: "raw",
      compareBranchId: "branch-2"
    }) as {
      series: Array<{ bucket_ts: string; count: number; avg: number; min: number; max: number; dirty_count: number; suspect_count: number }>;
      anomalies: Array<{ reasons: string[]; quality: string }>;
      comparison: { aggregate: string; points: Array<{ bucket_ts: string; delta_avg: number | null }> };
    };
    expect(hourly.series).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket_ts: "2026-10-07T09:00:00.000Z", count: 2, min: 22, max: 55 }),
      expect.objectContaining({ bucket_ts: "2026-10-07T11:00:00.000Z", dirty_count: 1 })
    ]));
    expect(hourly.anomalies.map((row) => row.reasons).flat()).toEqual(expect.arrayContaining(["jump", "out_of_range", "garbage_after_outage", "stale"]));
    expect(hourly.comparison).toMatchObject({ aggregate: "hourly" });
    expect(hourly.comparison.points.some((point) => point.bucket_ts === "2026-10-07T09:00:00.000Z" && point.delta_avg === 18.5)).toBe(true);

    const cleaned = services.telemetry.query({
      branchId: "branch-1",
      metric: "temperature",
      from: "2026-10-07T00:00:00.000Z",
      to: "2026-10-08T00:00:00.000Z",
      aggregate: "daily",
      mode: "cleaned"
    }) as { series: Array<{ count: number; min: number; max: number }> };
    expect(cleaned.series).toEqual([expect.objectContaining({ count: 2, min: 22, max: 55 })]);
    expect(repo.telemetry({ branchId: "branch-1", metric: "temperature" })).toHaveLength(5);
    db.close();
  });
});

describe("TraceService", () => {
  it("builds an ordered chain for a seeded book RFID", () => {
    const db = createDatabase(":memory:");
    const repo = new LibraryRepository(db);
    repo.insert("branches", { id: "branch-east", code: "EAST", name_zh: "校园东馆", name_en: "East Campus Library", type: "campus", address: "x", status: "active" });
    repo.insert("users", { id: "reader-001", role: "reader", username: "R-2048", email: "reader.demo@library.local", password_hash: "hash", display_name: "林知秋", status: "active", locked_until: null });
    repo.insert("devices", { id: "device-east-1", branch_id: "branch-east", kind: "kiosk", name: "East kiosk", vendor: "Mock", protocol: "mock", address: "kiosk://1", status: "online", config_json: "{}" });
    repo.insert("devices", { id: "device-east-3", branch_id: "branch-east", kind: "gate", name: "East gate", vendor: "Mock", protocol: "mock", address: "gate://1", status: "online", config_json: "{}" });
    repo.insert("devices", { id: "device-east-4", branch_id: "branch-east", kind: "camera", name: "East camera", vendor: "Mock", protocol: "mock", address: "camera://1", status: "online", config_json: "{}" });
    repo.insert("books", {
      id: "book-0001",
      isbn: "978-7-100001-1",
      title: "无人值守系统设计（第 2 版）",
      author: "陈墨",
      category: "TP201",
      branch_id: "branch-east",
      shelf_location: "EAST-B-02",
      edition: "2 edition",
      purchased_at: "2026-01-01T09:00:00.000Z",
      rfid_tag: "RFID-000001",
      status: "borrowed",
      cover_color: "#1F4D3A"
    });
    repo.insert("loans", {
      id: "loan-00001",
      book_id: "book-0001",
      user_id: "reader-001",
      branch_id: "branch-east",
      device_id: "device-east-1",
      borrowed_at: "2026-10-10T10:00:00.000Z",
      due_at: "2026-11-09T10:00:00.000Z",
      returned_at: "2026-10-10T10:30:00.000Z",
      renew_count: 0,
      status: "returned",
      idempotency_key: "seed-loan-1"
    });
    repo.insert("gate_events", {
      id: "gate-001",
      branch_id: "branch-east",
      device_id: "device-east-3",
      user_id: "reader-001",
      direction: "out",
      rfid_tags_json: JSON.stringify(["RFID-000001"]),
      authorized: 1,
      ts: "2026-10-10T10:12:00.000Z"
    });
    repo.insert("camera_clips", {
      id: "clip-001",
      device_id: "device-east-4",
      branch_id: "branch-east",
      start_ts: "2026-10-10T09:55:00.000Z",
      end_ts: "2026-10-10T10:35:00.000Z",
      file_path: "assets/placeholder.mp4"
    });
    repo.insert("alerts", {
      id: "alert-001",
      branch_id: "branch-east",
      device_id: "device-east-3",
      type: "theft",
      severity: "critical",
      message: "Trace fixture alert",
      status: "open",
      related_loan_id: "loan-00001",
      related_clip_id: "clip-001",
      created_at: "2026-10-10T10:15:00.000Z"
    });
    repo.insert("maintenance_records", {
      id: "maint-001",
      branch_id: "branch-east",
      device_id: "device-east-3",
      kind: "device_repair",
      description: "Inspect gate RFID reader",
      started_at: "2026-10-10T10:20:00.000Z",
      finished_at: null,
      operator_id: "reader-001",
      related_alert_id: "alert-001"
    });
    const services = createDomainServices(repo);
    const trace = services.trace.query({ book: "RFID-000001" }) as {
      window: { branchId: string; from: string; to: string };
      chain: Array<{ kind: string; record: Record<string, unknown> }>;
    };
    expect(trace.window).toMatchObject({ branchId: "branch-east", from: "2026-10-10T10:00:00.000Z", to: "2026-10-10T10:30:00.000Z" });
    expect(trace.chain.map((step) => step.kind)).toEqual(["book", "rfid_tag", "loan_transaction", "device_event", "device_event", "camera_clip", "alert", "maintenance"]);
    expect(trace.chain[2]!.record.who).toMatchObject({ user_id: "reader-001", name: "林知秋", account: "R-2048" });
    expect(trace.chain[4]!.record.rfid_tags).toEqual(["RFID-000001"]);
    expect(trace.chain[6]!.record.id).toBe("alert-001");
    expect(trace.chain[7]!.record.id).toBe("maint-001");
    db.close();
  });
});

describe("ExportService", () => {
  it("generates an xlsx export with localized sheets, columns, history, and audit log", async () => {
    const { db, repo, services } = fixture();
    const loan = services.circulation.borrow({
      bookId: "book-1",
      userId: "reader-1",
      branchId: "branch-1",
      deviceId: "device-1",
      idempotencyKey: "export-loan"
    }) as { id: string };
    repo.update("loans", loan.id, {
      borrowed_at: "2026-10-10T10:00:00.000Z",
      due_at: "2026-11-09T10:00:00.000Z",
      returned_at: null
    });

    const result = await services.exports.create({
      dataset: "loans",
      locale: "zh-CN",
      branchId: "branch-1",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-31T23:59:59.999Z"
    }, "admin-1", "127.0.0.1");
    const buffer = await services.exports.toBuffer(result.workbook);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0]);

    const dataSheet = workbook.getWorksheet("借阅");
    const summarySheet = workbook.getWorksheet("汇总");
    expect(dataSheet).toBeTruthy();
    expect(summarySheet).toBeTruthy();
    expect(dataSheet!.views).toEqual(expect.arrayContaining([expect.objectContaining({ state: "frozen", ySplit: 1 })]));
    expect(dataSheet!.getRow(1).values).toEqual(expect.arrayContaining(["借阅编号", "书名", "借出时间", "续借次数"]));
    expect(dataSheet!.getColumn(9).numFmt).toBe("yyyy-mm-dd hh:mm:ss");
    expect(dataSheet!.getColumn(12).numFmt).toBe("0");
    expect(dataSheet!.getRow(2).getCell(1).value).toBe(loan.id);
    expect(summarySheet!.getColumn(1).values).toEqual(expect.arrayContaining(["dataset", "rowCount"]));
    expect(repo.count("export_history", "dataset = 'loans' AND locale = 'zh-CN'")).toBe(1);
    expect(repo.count("audit_log", "action = 'export_dataset' AND entity = 'export'")).toBe(1);
    expect(String((result.history as unknown as { download_path: string }).download_path)).toMatch(/^\/api\/exports\/.+\/download$/);

    const preview = services.exports.preview({ dataset: "loans", branchId: "branch-1", locale: "en" }) as { rows: unknown[]; columns: Array<{ header: string }> };
    expect(preview.rows).toHaveLength(1);
    expect(preview.columns.map((column) => column.header)).toContain("Loan ID");
    db.close();
  });
});

describe("DeviceService", () => {
  it("registers devices with wizard config and exposes status fields", () => {
    const { db, services } = fixture();
    const device = services.devices.register({
      branch_id: "branch-1",
      kind: "smoke",
      name: "Smoke sensor",
      vendor: "Mock",
      protocol: "mock",
      address: "mock://smoke",
      config: {
        samplingIntervalSeconds: 45,
        thresholds: { smoke_ppm: { max: 8 } }
      }
    }) as unknown as { id: string; status: string; last_seen_at: string | null; config: { samplingIntervalSeconds: number; thresholds: { smoke_ppm: { max: number } } } };
    expect(device.status).toBe("offline");
    expect(device.last_seen_at).toBeNull();
    expect(device.config.samplingIntervalSeconds).toBe(45);
    expect(device.config.thresholds.smoke_ppm.max).toBe(8);
    const listed = services.devices.list({ status: "offline" }) as unknown as Array<{ id: string; status: string; last_seen_at: string | null }>;
    expect(listed.some((row) => row.id === device.id && row.status === "offline" && row.last_seen_at === null)).toBe(true);
    db.close();
  });

  it("updates config and sends commands through the adapter", async () => {
    const { db, repo, services } = fixture();
    const configured = services.devices.updateConfig("device-1", {
      samplingIntervalSeconds: 60,
      thresholds: { heartbeat: { min: 1, max: 1 } }
    }) as { config: { samplingIntervalSeconds: number } };
    expect(configured.config.samplingIntervalSeconds).toBe(60);
    const response = await services.devices.command("device-1", "ping", { nonce: "abc" }) as unknown as { result: { ok: boolean; command: string; payload: { nonce: string }; deviceId: string } };
    expect(response.result).toMatchObject({ ok: true, command: "ping", payload: { nonce: "abc" }, deviceId: "device-1" });
    const row = repo.get("devices", "device-1") as { status: string; last_seen_at: string | null };
    expect(row.status).toBe("online");
    expect(row.last_seen_at).toBeTruthy();
    db.close();
  });

  it("auto-registers a fault alert and draft maintenance record after failed health check", async () => {
    const { db, repo, services } = fixture();
    services.devices.updateConfig("device-1", {
      samplingIntervalSeconds: 30,
      thresholds: {},
      healthStatus: "fault",
      healthMessage: "simulated adapter failure"
    });
    const result = await services.devices.healthCheck("device-1", "admin-1") as unknown as {
      health: { status: string; message?: string };
      alert: { id: string; type: string; status: string; device_id: string };
      maintenance: { related_alert_id: string; finished_at: string | null; kind: string };
      device: { status: string; last_seen_at: string | null };
    };
    expect(result.health).toMatchObject({ status: "fault", message: "simulated adapter failure" });
    expect(result.device.status).toBe("fault");
    expect(result.device.last_seen_at).toBeNull();
    expect(result.alert).toMatchObject({ type: "device_fault", status: "open", device_id: "device-1" });
    expect(result.maintenance).toMatchObject({ related_alert_id: result.alert.id, finished_at: null, kind: "device_repair" });
    expect(repo.count("alerts", "device_id = @deviceId AND type = 'device_fault'", { deviceId: "device-1" })).toBe(1);
    expect(repo.count("maintenance_records", "device_id = @deviceId AND finished_at IS NULL", { deviceId: "device-1" })).toBe(1);
    db.close();
  });
});

describe("MaintenanceService", () => {
  it("creates, updates, completes, filters, and exposes a 30-day timeline", () => {
    const { db, repo, services } = fixture();
    const alert = services.alerts.create({
      branch_id: "branch-1",
      device_id: "device-1",
      type: "device_fault",
      severity: "warning",
      message: "Device needs repair",
      status: "open",
      related_loan_id: null,
      related_clip_id: null
    }) as { id: string };
    const created = services.maintenance.create({
      branch_id: "branch-1",
      device_id: "device-1",
      kind: "device_repair",
      description: "Inspect kiosk",
      started_at: new Date().toISOString(),
      finished_at: null,
      operator_id: "admin-1",
      related_alert_id: alert.id
    }) as { id: string; status: string };
    services.audit.log("admin-1", "create_maintenance", "maintenance", created.id, { kind: "device_repair" });
    expect(created.status).toBe("open");

    const updated = services.maintenance.update(created.id, { description: "Inspect kiosk RFID reader", kind: "device_repair" }) as { description: string; status: string };
    services.audit.log("admin-1", "update_maintenance", "maintenance", created.id, { description: updated.description });
    expect(updated).toMatchObject({ description: "Inspect kiosk RFID reader", status: "open" });

    const completed = services.maintenance.complete(created.id, { operator_id: "admin-1" }) as { status: string; finished_at: string };
    services.audit.log("admin-1", "complete_maintenance", "maintenance", created.id, { finished_at: completed.finished_at });
    expect(completed.status).toBe("completed");
    expect(completed.finished_at).toBeTruthy();

    const filtered = services.maintenance.list({ branchId: "branch-1", deviceId: "device-1", alertId: alert.id, kind: "device_repair", status: "completed" }) as Array<{ id: string }>;
    expect(filtered.map((row) => row.id)).toContain(created.id);
    const timeline = services.maintenance.timeline(30, { branchId: "branch-1" }) as Array<{ id: string; status: string }>;
    expect(timeline).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, status: "completed" })]));
    expect(repo.count("audit_log", "entity = 'maintenance' AND entity_id = @id", { id: created.id })).toBe(3);
    db.close();
  });
});
