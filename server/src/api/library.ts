import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, type Role } from "./auth.js";
import { DomainError } from "../domain/types.js";
import { assertBookTransition } from "../domain/bookState.js";
import type { createDomainServices } from "../domain/services.js";
import type { TelemetryPipeline } from "../integration/telemetryPipeline.js";

type Services = ReturnType<typeof createDomainServices>;
type LibraryRouterOptions = { telemetryPipeline?: TelemetryPipeline };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.string().optional(),
  branchId: z.string().optional(),
  userId: z.string().optional(),
  q: z.string().optional()
});
const alertQuerySchema = querySchema.extend({
  type: z.enum(["smoke", "intrusion", "theft", "device_offline", "device_fault", "threshold", "network"]).optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  from: z.string().optional(),
  to: z.string().optional()
});
const maintenanceKind = z.enum(["device_repair", "inventory", "book_mending", "restock"]);
const maintenanceQuerySchema = querySchema.extend({
  deviceId: z.string().optional(),
  alertId: z.string().optional(),
  kind: maintenanceKind.optional(),
  status: z.enum(["open", "completed"]).optional(),
  from: z.string().optional(),
  to: z.string().optional()
});
const telemetryQuerySchema = z.object({
  branchId: z.string().min(1),
  metric: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
  aggregate: z.enum(["raw", "hourly", "daily"]).default("raw"),
  mode: z.enum(["raw", "cleaned"]).default("raw"),
  compareBranchId: z.string().min(1).optional()
});
const traceQuerySchema = z.object({
  book: z.string().trim().min(1).optional(),
  loanId: z.string().trim().min(1).optional(),
  alertId: z.string().trim().min(1).optional()
}).refine((value) => [value.book, value.loanId, value.alertId].filter(Boolean).length === 1, "Provide exactly one of book, loanId, or alertId");
const exportQuerySchema = z.object({
  dataset: z.enum(["loans", "books", "readers", "telemetry", "alerts", "maintenance"]),
  locale: z.enum(["en", "zh-CN"]).default("en"),
  branchId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional()
});

const idSchema = z.object({ id: z.string().min(1) });
// Shared field rules for write bodies: non-empty bounded strings and parseable timestamps.
const ref = z.string().trim().min(1).max(128);
const text = (max: number) => z.string().trim().min(1).max(max);
const timestamp = z.string().trim().min(1).max(40).refine((value) => !Number.isNaN(Date.parse(value)), "Invalid timestamp");
const bookStatus = z.enum(["on_shelf", "borrowed", "lost", "repair"]);
const numericRule = (min: number, max: number) => z.number().int().min(min).max(max);
const deviceKind = z.enum(["kiosk", "rfid_reader", "gate", "camera", "temp_humidity", "light", "smoke", "pir", "shelf"]);
const deviceProtocol = z.enum(["tcp", "http", "mock", "legacy"]);
const thresholdSchema = z.record(z.string(), z.object({
  min: z.number().finite().optional(),
  max: z.number().finite().optional()
}).refine((value) => value.min === undefined || value.max === undefined || value.min <= value.max, "min must be less than or equal to max"));
const ruleValueSchemas: Record<string, z.ZodTypeAny> = {
  loan_days: numericRule(1, 365),
  max_loans: numericRule(1, 100),
  max_renewals: numericRule(0, 20),
  fine_per_day_cents: numericRule(0, 100_000),
  overdue_grace_days: numericRule(0, 365),
  alert_thresholds: thresholdSchema
};
const deviceConfigSchema = z.object({
  samplingIntervalSeconds: z.number().int().min(1).max(86400),
  thresholds: thresholdSchema
}).strict();

function actor(req: Request) {
  return (req as Request & { user?: { id: string; role: Role } }).user ?? { id: "system", role: "admin" as const };
}

function body<T extends z.ZodTypeAny>(schema: T, req: Request, res: Response) {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: "INVALID_INPUT", message: "Request body is invalid.", details: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data as z.infer<T>;
}

function query(req: Request, res: Response) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ code: "INVALID_QUERY", message: "Query parameters are invalid.", details: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data;
}

function alertQuery(req: Request, res: Response) {
  const parsed = alertQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ code: "INVALID_QUERY", message: "Query parameters are invalid.", details: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data;
}

function maintenanceQuery(req: Request, res: Response) {
  const parsed = maintenanceQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ code: "INVALID_QUERY", message: "Query parameters are invalid.", details: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data;
}

function telemetryQuery(req: Request, res: Response) {
  const parsed = telemetryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ code: "INVALID_QUERY", message: "Query parameters are invalid.", details: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data;
}

function traceQuery(req: Request, res: Response) {
  const parsed = traceQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ code: "INVALID_QUERY", message: "Query parameters are invalid.", details: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data;
}

function exportQuery(req: Request, res: Response) {
  const parsed = exportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ code: "INVALID_QUERY", message: "Query parameters are invalid.", details: parsed.error.flatten() });
    return undefined;
  }
  return parsed.data;
}

async function sendWorkbook(res: Response, workbook: Awaited<ReturnType<Services["exports"]["create"]>>["workbook"], fileName: string) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  await workbook.xlsx.write(res);
  res.end();
}

function withHandler(handler: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof DomainError) {
        const status = error.code === "FORBIDDEN" ? 403 : error.code.endsWith("NOT_FOUND") ? 404 : 409;
        res.status(status).json({ code: error.code, message: error.message, details: error.details ?? null });
        return;
      }
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        res.status(409).json({ code: "CONFLICT", message: "The request conflicts with existing data.", details: error.message });
        return;
      }
      res.status(500).json({ code: "INTERNAL_ERROR", message: "The server could not complete the request.", details: null });
    }
  };
}

export function createLibraryRouter(services: Services, options: LibraryRouterOptions = {}) {
  const router = Router();
  const manage = requireAuth("librarian", "admin");
  const admin = requireAuth("admin");
  const operate = requireAuth("reader", "librarian", "admin");

  router.get("/trace", manage, withHandler((req, res) => {
    const parsed = traceQuery(req, res); if (!parsed) return;
    res.json({ data: services.trace.query(parsed) });
  }));

  router.get("/exports/preview", manage, withHandler((req, res) => {
    const parsed = exportQuery(req, res); if (!parsed) return;
    res.json({ data: services.exports.preview(parsed) });
  }));
  router.get("/exports/history", manage, withHandler((req, res) => {
    const parsed = query(req, res); if (!parsed) return;
    res.json({ data: services.exports.history(parsed) });
  }));
  router.get("/exports/download", manage, withHandler(async (req, res) => {
    const parsed = exportQuery(req, res); if (!parsed) return;
    const result = await services.exports.create(parsed, actor(req).id, req.ip);
    await sendWorkbook(res, result.workbook, result.fileName);
  }));
  router.get("/exports/:id/download", manage, withHandler(async (req, res) => {
    const result = await services.exports.recreate(idSchema.parse(req.params).id, actor(req).id, req.ip);
    await sendWorkbook(res, result.workbook, result.fileName);
  }));

  router.get("/books", operate, withHandler((req, res) => {
    const parsed = query(req, res); if (!parsed) return;
    res.json({ data: services.catalog.list(parsed) });
  }));
  router.post("/books", manage, withHandler((req, res) => {
    const value = body(z.object({
      isbn: text(32), title: text(300), author: text(200), category: text(64), branch_id: ref,
      shelf_location: text(64), edition: text(64), purchased_at: timestamp, rfid_tag: text(64), status: bookStatus.default("on_shelf"), cover_color: text(32)
    }), req, res); if (!value) return;
    res.status(201).json({ data: services.catalog.create(value) });
  }));
  router.patch("/books/:id", manage, withHandler((req, res) => {
    const existing = services.catalog.get(idSchema.parse(req.params).id) as Record<string, unknown>;
    const value = body(z.object({
      isbn: text(32).optional(), title: text(300).optional(), author: text(200).optional(), category: text(64).optional(),
      branch_id: ref.optional(), shelf_location: text(64).optional(), edition: text(64).optional(),
      purchased_at: timestamp.optional(), rfid_tag: text(64).optional(), status: bookStatus.optional(),
      cover_color: text(32).optional()
    }).strict(), req, res); if (!value) return;
    if (value.status && value.status !== existing.status) {
      assertBookTransition(existing.status as "on_shelf" | "borrowed" | "lost" | "repair", value.status);
    }
    res.json({ data: services.catalog.update(idSchema.parse(req.params).id, value) });
  }));
  router.get("/books/:id", operate, withHandler((req, res) => res.json({ data: services.catalog.get(idSchema.parse(req.params).id) })));

  router.get("/readers", manage, withHandler((req, res) => {
    const parsed = query(req, res); if (!parsed) return;
    res.json({ data: services.members.list(parsed) });
  }));
  router.get("/readers/:id", operate, withHandler((req, res) => {
    const readerId = idSchema.parse(req.params).id;
    if (actor(req).role === "reader" && actor(req).id !== readerId) throw new DomainError("FORBIDDEN", "Readers may only view their own record");
    res.json({ data: services.members.get(readerId) });
  }));
  router.post("/readers", manage, withHandler((req, res) => {
    const value = body(z.object({
      role: z.literal("reader").default("reader"), username: text(64), email: z.string().email().max(254).optional(), password_hash: z.string().max(200).default(""),
      display_name: text(100), student_no: text(32).optional(), id_number_masked: text(32).optional(), card_no: text(32).optional(),
      qr_code: text(64).optional(), deposit_cents: z.number().int().nonnegative().max(10_000_000).default(0), status: z.enum(["active", "suspended"]).default("active")
    }), req, res); if (!value) return;
    res.status(201).json({ data: services.members.create(value) });
  }));
  router.patch("/readers/:id/status", manage, withHandler((req, res) => {
    const value = body(z.object({ status: z.enum(["active", "suspended"]), locked_until: timestamp.nullable().optional() }).strict(), req, res); if (!value) return;
    res.json({ data: services.members.update(idSchema.parse(req.params).id, value) });
  }));

  router.get("/loans", operate, withHandler((req, res) => {
    const parsed = query(req, res); if (!parsed) return;
    const scoped = actor(req).role === "reader" ? { ...parsed, userId: actor(req).id } : parsed;
    res.json({ data: services.circulation.listLoans(scoped) });
  }));
  router.post("/loans/borrow", operate, withHandler((req, res) => {
    const value = body(z.object({ bookId: ref, userId: ref, branchId: ref.optional(), deviceId: ref.optional(), idempotencyKey: ref }), req, res); if (!value) return;
    if (actor(req).role === "reader" && actor(req).id !== value.userId) throw new DomainError("FORBIDDEN", "Readers may only borrow for themselves");
    const data = services.circulation.borrow(value);
    services.audit.log(actor(req).id, "borrow", "loan", String((data as { id: string }).id), value, req.ip);
    res.status(201).json({ data });
  }));
  router.post("/loans/:id/return", operate, withHandler((req, res) => {
    const existing = services.circulation.getLoan(idSchema.parse(req.params).id);
    if (actor(req).role === "reader" && existing && String(existing.user_id) !== actor(req).id) throw new DomainError("FORBIDDEN", "Readers may only return their own loans");
    const data = services.circulation.returnLoan({ loanId: idSchema.parse(req.params).id });
    services.audit.log(actor(req).id, "return", "loan", String((data as { id: string }).id), {}, req.ip);
    res.json({ data });
  }));
  router.post("/loans/:id/renew", operate, withHandler((req, res) => {
    const existing = services.circulation.getLoan(idSchema.parse(req.params).id);
    if (actor(req).role === "reader" && existing && String(existing.user_id) !== actor(req).id) throw new DomainError("FORBIDDEN", "Readers may only renew their own loans");
    const data = services.circulation.renew({ loanId: idSchema.parse(req.params).id });
    services.audit.log(actor(req).id, "renew", "loan", String((data as { id: string }).id), {}, req.ip);
    res.json({ data });
  }));
  router.post("/loans/:id/lost", manage, withHandler((req, res) => {
    const loanId = idSchema.parse(req.params).id;
    const existing = services.circulation.getLoan(loanId);
    if (!existing) throw new DomainError("LOAN_NOT_FOUND", "Loan not found");
    const book = services.catalog.get(String(existing.book_id)) as Record<string, unknown>;
    if (book.status !== "lost") {
      assertBookTransition(book.status as "on_shelf" | "borrowed" | "lost" | "repair", "lost");
      services.catalog.update(String(existing.book_id), { status: "lost" });
    }
    const data = services.circulation.updateLoan(loanId, { status: "lost" });
    res.json({ data });
  }));
  router.post("/loans/:id/reminder", manage, withHandler((req, res) => {
    const loanId = idSchema.parse(req.params).id;
    const loan = services.circulation.getLoan(loanId);
    if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found");
    const notification = services.notifications.create({
      user_id: String(loan.user_id),
      loan_id: loanId,
      channel: "in_app",
      message: "图书已逾期，请尽快归还 / Your library loan is overdue. Please return it soon.",
      status: "queued",
      created_by: actor(req).id
    });
    services.audit.log(actor(req).id, "send_overdue_reminder", "loan", loanId, { notificationId: (notification as { id: string }).id }, req.ip);
    res.status(201).json({ data: notification });
  }));

  router.get("/reservations", operate, withHandler((req, res) => {
    const parsed = query(req, res); if (!parsed) return;
    const scoped = actor(req).role === "reader" ? { ...parsed, userId: actor(req).id } : parsed;
    res.json({ data: services.circulation.listReservations(scoped) });
  }));
  router.post("/reservations", operate, withHandler((req, res) => {
    const value = body(z.object({ bookId: ref, userId: ref }), req, res); if (!value) return;
    if (actor(req).role === "reader" && actor(req).id !== value.userId) throw new DomainError("FORBIDDEN", "Readers may only reserve for themselves");
    res.status(201).json({ data: services.circulation.reserve(value) });
  }));

  router.post("/help", operate, withHandler((req, res) => {
    const value = body(z.object({ branchId: ref.default("branch-east"), message: text(500).default("Reader requested remote support.") }), req, res);
    if (!value) return;
    res.status(201).json({ data: services.alerts.create({
      branch_id: value.branchId,
      device_id: null,
      type: "intrusion",
      severity: "info",
      message: value.message,
      status: "open",
      related_loan_id: null,
      related_clip_id: null
    }) });
  }));

  router.get("/devices", manage, withHandler((req, res) => {
    const parsed = query(req, res); if (!parsed) return;
    res.json({ data: services.devices.list(parsed) });
  }));
  router.post("/devices", admin, withHandler((req, res) => {
    const value = body(z.object({
      kind: deviceKind,
      protocol: deviceProtocol,
      address: text(256),
      branch_id: ref,
      name: text(100),
      vendor: text(100),
      thresholds: thresholdSchema.default({}),
      samplingIntervalSeconds: z.number().int().min(1).max(86400).default(30)
    }), req, res); if (!value) return;
    res.status(201).json({ data: services.devices.register({
      branch_id: value.branch_id,
      kind: value.kind,
      name: value.name,
      vendor: value.vendor,
      protocol: value.protocol,
      address: value.address,
      status: "offline",
      config: { samplingIntervalSeconds: value.samplingIntervalSeconds, thresholds: value.thresholds }
    }) });
  }));
  router.patch("/devices/:id/config", admin, withHandler((req, res) => {
    const value = body(deviceConfigSchema, req, res); if (!value) return;
    res.json({ data: services.devices.updateConfig(idSchema.parse(req.params).id, value) });
  }));
  router.post("/devices/:id/test-command", admin, withHandler(async (req, res) => {
    const value = body(z.object({
      command: text(64),
      payload: z.record(z.string(), z.unknown()).default({})
    }), req, res); if (!value) return;
    res.json({ data: await services.devices.command(idSchema.parse(req.params).id, value.command, value.payload) });
  }));
  router.post("/devices/:id/health-check", admin, withHandler(async (req, res) => {
    res.json({ data: await services.devices.healthCheck(idSchema.parse(req.params).id, actor(req).id) });
  }));

  router.get("/alerts", manage, withHandler((req, res) => {
    const parsed = alertQuery(req, res); if (!parsed) return;
    res.json({ data: services.alerts.list(parsed) });
  }));
  router.post("/alerts", manage, withHandler((req, res) => {
    const value = body(z.object({
      branch_id: ref,
      device_id: ref.nullable().optional(),
      type: z.enum(["smoke", "intrusion", "theft", "device_offline", "device_fault", "threshold", "network"]),
      severity: z.enum(["info", "warning", "critical"]),
      message: text(500),
      status: z.enum(["open", "acked", "resolved"]).default("open"),
      acked_by: ref.nullable().optional(),
      resolved_at: timestamp.nullable().optional(),
      related_loan_id: ref.nullable().optional(),
      related_clip_id: ref.nullable().optional()
    }), req, res); if (!value) return;
    res.status(201).json({ data: services.alerts.create(value) });
  }));
  router.post("/alerts/bulk-ack", manage, withHandler((req, res) => {
    const value = body(z.object({ ids: z.array(ref).min(1).max(200), note: text(1000).optional() }), req, res); if (!value) return;
    res.json({ data: services.alerts.bulkAck(value.ids, actor(req).id, value.note) });
  }));
  router.get("/alerts/:id", manage, withHandler((req, res) => res.json({ data: services.alerts.detail(idSchema.parse(req.params).id) })));
  router.post("/alerts/:id/ack", manage, withHandler((req, res) => {
    const value = body(z.object({ note: text(1000).optional() }).default({}), req, res); if (!value) return;
    res.json({ data: services.alerts.ack(idSchema.parse(req.params).id, actor(req).id, value.note) });
  }));
  router.post("/alerts/:id/resolve", manage, withHandler((req, res) => {
    const value = body(z.object({ note: text(1000).optional() }).default({}), req, res); if (!value) return;
    res.json({ data: services.alerts.resolve(idSchema.parse(req.params).id, actor(req).id, value.note) });
  }));
  router.post("/alerts/:id/notes", manage, withHandler((req, res) => {
    const value = body(z.object({ note: text(1000) }), req, res); if (!value) return;
    res.status(201).json({ data: services.alerts.addNote(idSchema.parse(req.params).id, actor(req).id, value.note) });
  }));

  router.get("/telemetry", manage, withHandler((req, res) => {
    const parsed = telemetryQuery(req, res); if (!parsed) return;
    res.json({ data: services.telemetry.query(parsed) });
  }));
  router.post("/telemetry", manage, withHandler((req, res) => {
    const value = body(z.object({ deviceId: ref, branchId: ref, metric: text(64), value: z.number().finite(), ts: timestamp.optional() }), req, res); if (!value) return;
    if (options.telemetryPipeline) {
      options.telemetryPipeline.enqueue({ ...value, ts: value.ts ?? new Date().toISOString(), source: "api" });
      res.status(202).json({ data: { accepted: true, queued: options.telemetryPipeline.size() } });
      return;
    }
    res.status(201).json({ data: services.telemetry.ingest(value) });
  }));

  router.post("/telemetry/archive", admin, withHandler((req, res) => {
    const data = services.telemetry.archive();
    services.audit.log(actor(req).id, "archive_telemetry", "telemetry", data.cutoff, data, req.ip);
    res.json({ data });
  }));

  router.get("/maintenance/timeline", manage, withHandler((req, res) => {
    const parsed = z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      branchId: z.string().optional(),
      deviceId: z.string().optional()
    }).safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: "INVALID_QUERY", message: "Query parameters are invalid.", details: parsed.error.flatten() });
      return;
    }
    res.json({ data: services.maintenance.timeline(parsed.data.days, { branchId: parsed.data.branchId, deviceId: parsed.data.deviceId }) });
  }));
  router.get("/maintenance", manage, withHandler((req, res) => {
    const parsed = maintenanceQuery(req, res); if (!parsed) return;
    res.json({ data: services.maintenance.list(parsed) });
  }));
  router.post("/maintenance", manage, withHandler((req, res) => {
    const value = body(z.object({
      branch_id: ref,
      device_id: ref.nullable().optional(),
      kind: maintenanceKind,
      description: text(1000),
      started_at: timestamp,
      finished_at: timestamp.nullable().optional(),
      operator_id: ref.nullable().optional(),
      related_alert_id: ref.nullable().optional()
    }), req, res); if (!value) return;
    const data = services.maintenance.create(value);
    services.audit.log(actor(req).id, "create_maintenance", "maintenance", String((data as unknown as { id: string }).id), value, req.ip);
    res.status(201).json({ data });
  }));
  router.patch("/maintenance/:id", manage, withHandler((req, res) => {
    const value = body(z.object({
      branch_id: ref.optional(),
      device_id: ref.nullable().optional(),
      kind: maintenanceKind.optional(),
      description: text(1000).optional(),
      started_at: timestamp.optional(),
      finished_at: timestamp.nullable().optional(),
      operator_id: ref.nullable().optional(),
      related_alert_id: ref.nullable().optional()
    }).strict(), req, res); if (!value) return;
    const id = idSchema.parse(req.params).id;
    const data = services.maintenance.update(id, value);
    services.audit.log(actor(req).id, "update_maintenance", "maintenance", id, value, req.ip);
    res.json({ data });
  }));
  router.post("/maintenance/:id/complete", manage, withHandler((req, res) => {
    const value = body(z.object({
      finished_at: timestamp.optional(),
      operator_id: ref.nullable().optional(),
      description: text(1000).optional(),
      related_alert_id: ref.nullable().optional()
    }).default({}), req, res); if (!value) return;
    const id = idSchema.parse(req.params).id;
    const data = services.maintenance.complete(id, value);
    services.audit.log(actor(req).id, "complete_maintenance", "maintenance", id, value, req.ip);
    res.json({ data });
  }));

  router.get("/rules", operate, withHandler((_req, res) => res.json({ data: services.rules.list(), lastChanged: services.rules.latestAudit() ?? null })));
  router.put("/rules/:key", manage, withHandler((req, res) => {
    const ruleValue = ruleValueSchemas[String(req.params.key)];
    if (!ruleValue) throw new DomainError("RULE_NOT_FOUND", "Unknown rule key");
    const value = body(z.object({ value: ruleValue, description: text(200) }), req, res); if (!value) return;
    const data = services.rules.upsert(String(req.params.key), value.value, value.description);
    services.audit.log(actor(req).id, "update_rule", "rule", String(req.params.key), { value: value.value, description: value.description }, req.ip);
    res.json({ data, lastChanged: services.rules.latestAudit() ?? null });
  }));
  router.get("/branches", operate, withHandler((_req, res) => res.json({ data: services.branches.list({ limit: 100 }) })));
  router.get("/stats/overview", manage, withHandler((_req, res) => res.json({ data: services.stats.overview() })));

  return router;
}
