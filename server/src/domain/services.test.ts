import { describe, expect, it } from "vitest";
import { createDatabase } from "../persistence/database.js";
import { LibraryRepository } from "../persistence/repositories.js";
import { createDomainServices } from "./services.js";

function fixture() {
  const db = createDatabase(":memory:");
  const repo = new LibraryRepository(db);
  repo.insert("branches", { id: "branch-1", code: "T1", name_zh: "测试馆", name_en: "Test Library", type: "campus", address: "Test", status: "active" });
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
