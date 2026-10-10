import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { LibraryRepository } from "../persistence/repositories.js";
import { createDomainServices } from "./services.js";

function fixture() {
  const db = createDatabase(":memory:");
  const repo = new LibraryRepository(db);
  repo.insert("branches", { id: "branch-1", code: "T1", name_zh: "测试馆", name_en: "Test Library", type: "campus", address: "Test", status: "active" });
  repo.insert("users", { id: "admin-1", role: "admin", username: "admin", email: "admin@test", password_hash: "hash", display_name: "Admin", status: "active", locked_until: null });
  repo.insert("users", { id: "reader-1", role: "reader", username: "reader", email: "reader@test", password_hash: "hash", display_name: "Test Reader", student_no: "1", id_number_masked: "****", card_no: "CARD-1", qr_code: "QR-1", deposit_cents: 0, status: "active", locked_until: null });
  repo.insert("books", { id: "book-1", isbn: "978-1", title: "Test Book", author: "Test Author", category: "I247", branch_id: "branch-1", shelf_location: "A-01", edition: "1", purchased_at: "2026-01-01", rfid_tag: "RFID-1", status: "on_shelf", cover_color: "#1F4D3A" });
  repo.insert("devices", { id: "device-1", branch_id: "branch-1", kind: "kiosk", name: "Kiosk", vendor: "Mock", protocol: "mock", address: "mock://1", status: "online", last_seen_at: new Date().toISOString(), config_json: "{}" });
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
