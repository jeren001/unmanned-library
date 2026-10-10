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

const idSchema = z.object({ id: z.string().min(1) });
const deviceKind = z.enum(["kiosk", "rfid_reader", "gate", "camera", "temp_humidity", "light", "smoke", "pir", "shelf"]);
const deviceProtocol = z.enum(["tcp", "http", "mock", "legacy"]);
const thresholdSchema = z.record(z.string(), z.object({
  min: z.number().finite().optional(),
  max: z.number().finite().optional()
}).refine((value) => value.min === undefined || value.max === undefined || value.min <= value.max, "min must be less than or equal to max"));
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

function withHandler(handler: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof DomainError) {
        res.status(error.code.endsWith("NOT_FOUND") ? 404 : 409).json({ code: error.code, message: error.message, details: error.details ?? null });
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

  router.get("/books", operate, withHandler((req, res) => {
    const parsed = query(req, res); if (!parsed) return;
    res.json({ data: services.catalog.list(parsed) });
  }));
  router.post("/books", manage, withHandler((req, res) => {
    const value = body(z.object({
      isbn: z.string(), title: z.string(), author: z.string(), category: z.string(), branch_id: z.string(),
      shelf_location: z.string(), edition: z.string(), purchased_at: z.string(), rfid_tag: z.string(), status: z.enum(["on_shelf", "borrowed", "lost", "repair"]).default("on_shelf"), cover_color: z.string()
    }), req, res); if (!value) return;
    res.status(201).json({ data: services.catalog.create(value) });
  }));
  router.patch("/books/:id", manage, withHandler((req, res) => {
    const existing = services.catalog.get(idSchema.parse(req.params).id) as Record<string, unknown>;
    const value = body(z.object({
      isbn: z.string().optional(), title: z.string().optional(), author: z.string().optional(), category: z.string().optional(),
      branch_id: z.string().optional(), shelf_location: z.string().optional(), edition: z.string().optional(),
      purchased_at: z.string().optional(), rfid_tag: z.string().optional(), status: z.enum(["on_shelf", "borrowed", "lost", "repair"]).optional(),
      cover_color: z.string().optional()
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
  router.get("/readers/:id", operate, withHandler((req, res) => res.json({ data: services.members.get(idSchema.parse(req.params).id) })));
  router.post("/readers", manage, withHandler((req, res) => {
    const value = body(z.object({
      role: z.literal("reader").default("reader"), username: z.string(), email: z.string().email().optional(), password_hash: z.string().default(""),
      display_name: z.string(), student_no: z.string().optional(), id_number_masked: z.string().optional(), card_no: z.string().optional(),
      qr_code: z.string().optional(), deposit_cents: z.number().int().nonnegative().default(0), status: z.string().default("active")
    }), req, res); if (!value) return;
    res.status(201).json({ data: services.members.create(value) });
  }));
  router.patch("/readers/:id/status", manage, withHandler((req, res) => {
    const value = body(z.object({ status: z.enum(["active", "suspended"]), locked_until: z.string().nullable().optional() }), req, res); if (!value) return;
    res.json({ data: services.members.update(idSchema.parse(req.params).id, value) });
  }));

  router.get("/loans", operate, withHandler((req, res) => {
    const parsed = query(req, res); if (!parsed) return;
    const scoped = actor(req).role === "reader" ? { ...parsed, userId: actor(req).id } : parsed;
    res.json({ data: services.circulation.listLoans(scoped) });
  }));
  router.post("/loans/borrow", operate, withHandler((req, res) => {
    const value = body(z.object({ bookId: z.string(), userId: z.string(), branchId: z.string().optional(), deviceId: z.string().optional(), idempotencyKey: z.string().min(1) }), req, res); if (!value) return;
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
    const value = body(z.object({ bookId: z.string(), userId: z.string() }), req, res); if (!value) return;
    if (actor(req).role === "reader" && actor(req).id !== value.userId) throw new DomainError("FORBIDDEN", "Readers may only reserve for themselves");
    res.status(201).json({ data: services.circulation.reserve(value) });
  }));

  router.post("/help", operate, withHandler((req, res) => {
    const value = body(z.object({ branchId: z.string().default("branch-east"), message: z.string().default("Reader requested remote support.") }), req, res);
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
      address: z.string().trim().min(1),
      branch_id: z.string().trim().min(1),
      name: z.string().trim().min(1),
      vendor: z.string().trim().min(1),
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
      command: z.string().trim().min(1),
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
      branch_id: z.string(),
      device_id: z.string().nullable().optional(),
      type: z.enum(["smoke", "intrusion", "theft", "device_offline", "device_fault", "threshold", "network"]),
      severity: z.enum(["info", "warning", "critical"]),
      message: z.string(),
      status: z.enum(["open", "acked", "resolved"]).default("open"),
      acked_by: z.string().nullable().optional(),
      resolved_at: z.string().nullable().optional(),
      related_loan_id: z.string().nullable().optional(),
      related_clip_id: z.string().nullable().optional()
    }), req, res); if (!value) return;
    res.status(201).json({ data: services.alerts.create(value) });
  }));
  router.post("/alerts/bulk-ack", manage, withHandler((req, res) => {
    const value = body(z.object({ ids: z.array(z.string().min(1)).min(1).max(200), note: z.string().trim().min(1).optional() }), req, res); if (!value) return;
    res.json({ data: services.alerts.bulkAck(value.ids, actor(req).id, value.note) });
  }));
  router.get("/alerts/:id", manage, withHandler((req, res) => res.json({ data: services.alerts.detail(idSchema.parse(req.params).id) })));
  router.post("/alerts/:id/ack", manage, withHandler((req, res) => {
    const value = body(z.object({ note: z.string().trim().min(1).optional() }).default({}), req, res); if (!value) return;
    res.json({ data: services.alerts.ack(idSchema.parse(req.params).id, actor(req).id, value.note) });
  }));
  router.post("/alerts/:id/resolve", manage, withHandler((req, res) => {
    const value = body(z.object({ note: z.string().trim().min(1).optional() }).default({}), req, res); if (!value) return;
    res.json({ data: services.alerts.resolve(idSchema.parse(req.params).id, actor(req).id, value.note) });
  }));
  router.post("/alerts/:id/notes", manage, withHandler((req, res) => {
    const value = body(z.object({ note: z.string().trim().min(1) }), req, res); if (!value) return;
    res.status(201).json({ data: services.alerts.addNote(idSchema.parse(req.params).id, actor(req).id, value.note) });
  }));

  router.get("/telemetry", manage, withHandler((req, res) => {
    const parsed = query(req, res); if (!parsed) return;
    const metric = typeof req.query.metric === "string" ? req.query.metric : undefined;
    res.json({ data: services.telemetry.query({ ...parsed, metric, from: typeof req.query.from === "string" ? req.query.from : undefined, to: typeof req.query.to === "string" ? req.query.to : undefined }) });
  }));
  router.post("/telemetry", manage, withHandler((req, res) => {
    const value = body(z.object({ deviceId: z.string(), branchId: z.string(), metric: z.string(), value: z.number(), ts: z.string().optional() }), req, res); if (!value) return;
    if (options.telemetryPipeline) {
      options.telemetryPipeline.enqueue({ ...value, ts: value.ts ?? new Date().toISOString(), source: "api" });
      res.status(202).json({ data: { accepted: true, queued: options.telemetryPipeline.size() } });
      return;
    }
    res.status(201).json({ data: services.telemetry.ingest(value) });
  }));

  router.get("/maintenance", manage, withHandler((req, res) => {
    const parsed = query(req, res); if (!parsed) return;
    res.json({ data: services.maintenance.list(parsed) });
  }));
  router.post("/maintenance", manage, withHandler((req, res) => {
    const value = body(z.object({ branch_id: z.string(), device_id: z.string().nullable().optional(), kind: z.string(), description: z.string(), started_at: z.string(), finished_at: z.string().nullable().optional(), operator_id: z.string().nullable().optional(), related_alert_id: z.string().nullable().optional() }), req, res); if (!value) return;
    res.status(201).json({ data: services.maintenance.create(value) });
  }));

  router.get("/rules", operate, withHandler((_req, res) => res.json({ data: services.rules.list(), lastChanged: services.rules.latestAudit() ?? null })));
  router.put("/rules/:key", manage, withHandler((req, res) => {
    const value = body(z.object({ value: z.unknown(), description: z.string() }), req, res); if (!value) return;
    const data = services.rules.upsert(String(req.params.key), value.value, value.description);
    services.audit.log(actor(req).id, "update_rule", "rule", String(req.params.key), { value: value.value, description: value.description }, req.ip);
    res.json({ data, lastChanged: services.rules.latestAudit() ?? null });
  }));
  router.get("/branches", operate, withHandler((_req, res) => res.json({ data: services.branches.list({ limit: 100 }) })));
  router.get("/stats/overview", manage, withHandler((_req, res) => res.json({ data: services.stats.overview() })));

  return router;
}
