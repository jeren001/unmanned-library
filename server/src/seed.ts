import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import bcrypt from "bcrypt";
import { createDatabase } from "./persistence/database.js";

type Row = Record<string, unknown>;

const dbFile = process.env.DB_FILE ?? resolve(process.cwd(), "data/library.sqlite");
const db = createDatabase(dbFile);
const now = new Date("2026-10-07T09:00:00.000Z");

function rng(seed = 20241007) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const random = rng();
const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
const iso = (date: Date) => date.toISOString();
const daysAgo = (days: number, hours = 0) => new Date(now.getTime() - (days * 24 + hours) * 3600_000);

function insert(table: string, row: Row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((column) => `@${column}`).join(",")})`).run(row);
}

function stamped(row: Row) {
  return { ...row, created_at: iso(now), updated_at: iso(now) };
}

function reset() {
  db.exec(`
    DELETE FROM audit_log;
    DELETE FROM gate_events;
    DELETE FROM camera_clips;
    DELETE FROM maintenance_records;
    DELETE FROM alerts;
    DELETE FROM telemetry_hourly;
    DELETE FROM telemetry;
    DELETE FROM fines;
    DELETE FROM reservations;
    DELETE FROM loans;
    DELETE FROM devices;
    DELETE FROM books;
    DELETE FROM users;
    DELETE FROM branches;
    DELETE FROM rules;
  `);
}

function seedRules() {
  const rules = [
    ["loan_days", 30, "Default reader loan period in days"],
    ["max_loans", 8, "Maximum active loans for one reader"],
    ["max_renewals", 2, "Maximum renewals per loan"],
    ["fine_per_day_cents", 50, "Overdue fine per day"],
    ["overdue_grace_days", 1, "Grace period before fines apply"],
    ["alert_thresholds", { temperature: { min: 10, max: 32 }, humidity: { min: 25, max: 75 }, smoke_ppm: { max: 8 }, light_lux: { min: 80, max: 900 } }, "Telemetry thresholds"]
  ] as const;
  for (const [key, value, description] of rules) insert("rules", stamped({ key, value_json: JSON.stringify(value), description }));
}

const branches = [
  { id: "branch-east", code: "EAST", name_zh: "校园东馆", name_en: "East Campus Library", type: "campus", address: "东校区明德路 18 号", status: "active" },
  { id: "branch-west", code: "WEST", name_zh: "校园西区自习馆", name_en: "West Study Pod", type: "campus", address: "西区知行楼一层", status: "active" },
  { id: "branch-sunshine", code: "SUN", name_zh: "阳光社区图书角", name_en: "Sunshine Community Corner", type: "community", address: "阳光社区服务中心 2 层", status: "active" }
];

function seedBranches() {
  for (const branch of branches) insert("branches", stamped(branch));
}

function seedUsers() {
  const hash = bcrypt.hashSync("reader123", 10);
  insert("users", stamped({ id: "reader-001", role: "reader", username: "R-2048", email: "reader.demo@library.local", password_hash: hash, display_name: "林知秋", student_no: "20240001", id_number_masked: "3201********1024", card_no: "20240001", qr_code: "QR-20240001", deposit_cents: 10000, status: "active", locked_until: null }));
  insert("users", stamped({ id: "librarian-001", role: "librarian", username: "librarian", email: "librarian@library.local", password_hash: bcrypt.hashSync("librarian123", 10), display_name: "馆员值班台", student_no: null, id_number_masked: null, card_no: null, qr_code: null, deposit_cents: 0, status: "active", locked_until: null }));
  insert("users", stamped({ id: "admin-001", role: "admin", username: "admin", email: "admin@library.local", password_hash: bcrypt.hashSync("admin123", 10), display_name: "系统管理员", student_no: null, id_number_masked: null, card_no: null, qr_code: null, deposit_cents: 0, status: "active", locked_until: null }));
  const family = ["陈", "王", "李", "赵", "周", "吴", "郑", "何", "林", "郭", "许", "孙"];
  const given = ["安宁", "书禾", "明远", "知夏", "嘉木", "云起", "清越", "思源", "一诺", "景行"];
  for (let i = 2; i <= 60; i += 1) {
    const no = `2024${String(i).padStart(4, "0")}`;
    insert("users", stamped({
      id: `reader-${String(i).padStart(3, "0")}`,
      role: "reader",
      username: `R-${no}`,
      email: `reader${i}@library.local`,
      password_hash: hash,
      display_name: `${pick(family)}${pick(given)}`,
      student_no: no,
      id_number_masked: `3201********${String(1000 + i)}`,
      card_no: no,
      qr_code: `QR-${no}`,
      deposit_cents: 10000 + Math.floor(random() * 5000),
      status: random() > 0.04 ? "active" : "suspended",
      locked_until: null
    }));
  }
}

const zhTitles = ["数字图书馆导论", "城市阅读空间", "现代软件体系结构", "无人值守系统设计", "传感器网络基础", "机器学习实践", "数据库系统概论", "中国古代文学史", "公共服务设计", "智能硬件接口"];
const enTitles = ["Architecture Patterns", "Designing Data Systems", "Quiet Operations", "RFID Handbook", "Service Design Field Notes", "Learning TypeScript", "SQLite in Practice", "The Library at Night", "Human-Centered Security", "Networked Sensors"];
const authors = ["钱宁", "刘嘉", "王晓明", "陈墨", "Martin Fowler", "Rebecca Solnit", "Donald Knuth", "张岱", "林语堂", "Kent Beck"];
const categories = ["A", "B", "C", "D", "F", "G", "H", "I", "J", "N", "O", "TP"];
const colors = ["#1F4D3A", "#B07A1E", "#2F5D8A", "#7B4D2A", "#8C4A3B", "#4A5650", "#2E7D5B"];

function seedBooks() {
  for (let i = 1; i <= 300; i += 1) {
    const branch = branches[(i - 1) % branches.length]!;
    const chinese = i % 2 === 1;
    const base = chinese ? pick(zhTitles) : pick(enTitles);
    insert("books", stamped({
      id: `book-${String(i).padStart(4, "0")}`,
      isbn: `978-7-${String(100000 + i).slice(0, 6)}-${String(i % 10)}`,
      title: `${base}${chinese ? `（第 ${1 + (i % 4)} 版）` : ` Vol. ${1 + (i % 5)}`}`,
      author: pick(authors),
      category: `${pick(categories)}${100 + (i % 800)}`,
      branch_id: branch.id,
      shelf_location: `${branch.code}-${String.fromCharCode(65 + (i % 8))}-${String(1 + (i % 40)).padStart(2, "0")}`,
      edition: `${1 + (i % 5)} edition`,
      purchased_at: iso(daysAgo(20 + (i % 900))),
      rfid_tag: `RFID-${String(i).padStart(6, "0")}`,
      status: "on_shelf",
      cover_color: pick(colors)
    }));
  }
}

function seedDevices() {
  const kinds = ["kiosk", "rfid_reader", "gate", "camera", "temp_humidity", "light", "smoke", "pir", "shelf", "shelf"] as const;
  for (const branch of branches) {
    kinds.forEach((kind, index) => {
      insert("devices", stamped({
        id: `device-${branch.code.toLowerCase()}-${index + 1}`,
        branch_id: branch.id,
        kind,
        name: `${branch.name_en} ${kind.replace("_", " ")} ${index + 1}`,
        vendor: pick(["Horizon IoT", "Nanjing RFID", "MockWorks", "BranchSense"]),
        // The legacy device is simulated through the mock transport because the
        // current SQLite protocol constraint intentionally accepts tcp/http/mock.
        protocol: "mock",
        address: `10.${branches.indexOf(branch) + 1}.0.${20 + index}`,
        status: random() > 0.12 ? "online" : pick(["offline", "fault"]),
        last_seen_at: iso(daysAgo(0, Math.floor(random() * 12))),
        config_json: JSON.stringify({ samplingSeconds: 30 + index * 5, thresholdProfile: branch.code })
      }));
    });
  }
}

function seedLoans() {
  for (let i = 1; i <= 1200; i += 1) {
    const bookId = `book-${String(1 + (i % 270)).padStart(4, "0")}`;
    const userId = i % 10 === 0 ? "reader-001" : `reader-${String(1 + (i % 60)).padStart(3, "0")}`;
    const branch = branches[i % branches.length]!;
    const borrowed = daysAgo(1 + (i % 220), i % 18);
    const due = new Date(borrowed); due.setDate(due.getDate() + 30);
    const returned = new Date(due); returned.setDate(returned.getDate() - Math.floor(random() * 12));
    insert("loans", stamped({
      id: `loan-${String(i).padStart(5, "0")}`,
      book_id: bookId,
      user_id: userId,
      branch_id: branch.id,
      device_id: `device-${branch.code.toLowerCase()}-1`,
      borrowed_at: iso(borrowed),
      due_at: iso(due),
      returned_at: iso(returned),
      renew_count: i % 3,
      status: "returned",
      idempotency_key: `seed-loan-${i}`
    }));
  }
  for (let i = 1; i <= 25; i += 1) {
    const loanId = `loan-overdue-${String(i).padStart(3, "0")}`;
    const bookId = `book-${String(270 + i).padStart(4, "0")}`;
    const branch = branches[i % branches.length]!;
    const borrowed = daysAgo(45 + i);
    const due = daysAgo(15 + i);
    insert("loans", stamped({ id: loanId, book_id: bookId, user_id: `reader-${String(1 + (i % 60)).padStart(3, "0")}`, branch_id: branch.id, device_id: `device-${branch.code.toLowerCase()}-1`, borrowed_at: iso(borrowed), due_at: iso(due), returned_at: null, renew_count: i % 2, status: "overdue", idempotency_key: `seed-overdue-${i}` }));
    db.prepare("UPDATE books SET status='borrowed', updated_at=? WHERE id=?").run(iso(now), bookId);
  }
  for (let i = 1; i <= 5; i += 1) {
    const bookId = `book-${String(295 + i).padStart(4, "0")}`;
    const branch = branches[i % branches.length]!;
    insert("loans", stamped({ id: `loan-lost-${i}`, book_id: bookId, user_id: `reader-${String(10 + i).padStart(3, "0")}`, branch_id: branch.id, device_id: `device-${branch.code.toLowerCase()}-1`, borrowed_at: iso(daysAgo(120 + i)), due_at: iso(daysAgo(90 + i)), returned_at: null, renew_count: 0, status: "lost", idempotency_key: `seed-lost-${i}` }));
    db.prepare("UPDATE books SET status='lost', updated_at=? WHERE id=?").run(iso(now), bookId);
  }
}

function seedTelemetry() {
  const metrics = ["temperature", "humidity", "light_lux", "smoke_ppm", "occupancy"];
  for (const branch of branches) {
    for (let hour = 30 * 24; hour >= 1; hour -= 1) {
      for (const metric of metrics) {
        const dirty = random() < 0.01;
        const value = dirty ? 999999 : metric === "temperature" ? 18 + random() * 10 : metric === "humidity" ? 35 + random() * 35 : metric === "light_lux" ? 120 + random() * 650 : metric === "smoke_ppm" ? random() * 5 : Math.floor(random() * 90);
        const ts = new Date(now.getTime() - hour * 3600_000);
        const deviceId = metric === "smoke_ppm" ? 7 : metric === "light_lux" ? 6 : metric === "occupancy" ? 8 : 5;
        insert("telemetry", stamped({ id: `tel-${branch.code}-${hour}-${metric}`, device_id: `device-${branch.code.toLowerCase()}-${deviceId}`, branch_id: branch.id, metric, value, quality: dirty ? "dirty" : "ok", ts: iso(ts) }));
      }
    }
  }
  db.exec(`
    INSERT INTO telemetry_hourly(branch_id, metric, hour_ts, avg, min, max, count)
    SELECT branch_id, metric, substr(ts, 1, 13) || ':00:00.000Z', avg(value), min(value), max(value), count(*)
    FROM telemetry
    GROUP BY branch_id, metric, substr(ts, 1, 13);
  `);
}

function seedAlertsMaintenanceAndClips() {
  const assetPath = resolve(process.cwd(), "assets/placeholder.mp4");
  mkdirSync(dirname(assetPath), { recursive: true });
  writeFileSync(assetPath, Buffer.from("AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=", "base64"));
  for (let i = 1; i <= 15; i += 1) {
    const branch = branches[i % branches.length]!;
    insert("camera_clips", stamped({ id: `clip-${String(i).padStart(3, "0")}`, device_id: `device-${branch.code.toLowerCase()}-4`, branch_id: branch.id, start_ts: iso(daysAgo(i, 1)), end_ts: iso(daysAgo(i, 0)), file_path: "assets/placeholder.mp4" }));
  }
  const alertTypes = ["smoke", "intrusion", "theft", "device_offline", "device_fault", "threshold", "network"];
  const severities = ["info", "warning", "critical"];
  const statuses = ["open", "acked", "resolved"];
  for (let i = 1; i <= 40; i += 1) {
    const branch = branches[i % branches.length]!;
    const status = pick(statuses);
    insert("alerts", stamped({ id: `alert-${String(i).padStart(3, "0")}`, branch_id: branch.id, device_id: `device-${branch.code.toLowerCase()}-${1 + (i % 10)}`, type: pick(alertTypes), severity: pick(severities), message: `Simulated ${i} alert at ${branch.name_en}`, status, acked_by: status !== "open" ? "librarian-001" : null, resolved_at: status === "resolved" ? iso(daysAgo(i % 20)) : null, related_loan_id: i % 9 === 0 ? `loan-${String(i).padStart(5, "0")}` : null, related_clip_id: i <= 15 ? `clip-${String(i).padStart(3, "0")}` : null }));
  }
  const kinds = ["device_repair", "inventory", "book_mending", "restock"];
  for (let i = 1; i <= 20; i += 1) {
    const branch = branches[i % branches.length]!;
    insert("maintenance_records", stamped({ id: `maint-${String(i).padStart(3, "0")}`, branch_id: branch.id, device_id: i % 4 === 0 ? null : `device-${branch.code.toLowerCase()}-${1 + (i % 10)}`, kind: pick(kinds), description: `Maintenance work order ${i}`, started_at: iso(daysAgo(i)), finished_at: i % 3 === 0 ? null : iso(daysAgo(i, -2)), operator_id: "librarian-001", related_alert_id: i <= 12 ? `alert-${String(i).padStart(3, "0")}` : null }));
  }
}

const tx = db.transaction(() => {
  reset();
  seedRules();
  seedBranches();
  seedUsers();
  seedBooks();
  seedDevices();
  seedLoans();
  seedTelemetry();
  seedAlertsMaintenanceAndClips();
});

tx();
console.log(`Seeded ${dbFile}`);
console.log("branches=3 books=300 readers=60 devices=30 loans=1230 telemetry=10800 alerts=40 maintenance=20 clips=15");
db.close();
