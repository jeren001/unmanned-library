import express, { type NextFunction, type Request, type Response } from "express";
import { createAuthRouter, requireAuth } from "./auth.js";
import { healthRouter } from "./health.js";
import { createLibraryRouter } from "./library.js";
import { createPublicRouter } from "./public.js";
import { createPersistence } from "../persistence/index.js";
import { createDomainServices } from "../domain/services.js";
import { EventBus } from "../events/bus.js";
import { AlertRulesEngine } from "../domain/alertRules.js";
import { streamEvents } from "./stream.js";
import { LibrarySimulator } from "../simulator/index.js";
import { TelemetryPipeline } from "../integration/telemetryPipeline.js";

export function createServer(filename?: string) {
  const app = express();
  const persistence = createPersistence(filename);
  const bus = new EventBus();
  const telemetryPipeline = new TelemetryPipeline(persistence.repo, bus);
  const services = createDomainServices(persistence.repo, bus);
  const rules = new AlertRulesEngine(persistence.repo, bus);
  // Off by default: an admin starts it on Settings · Simulator, or SIMULATOR_ENABLED=true starts it with the server.
  const simulatorAutostart = process.env.SIMULATOR_ENABLED === "true";
  const simulator = new LibrarySimulator(persistence.repo, bus, {
    enabled: simulatorAutostart,
    intervalMs: Number(process.env.SIMULATOR_INTERVAL_MS ?? 5_000),
    seed: Number(process.env.SIMULATOR_SEED ?? 42)
  }, telemetryPipeline);
  const publishKpi = (branchId?: string | null) => bus.publishNoWait("kpi.updated", {
    branchId: branchId ?? null,
    stats: { ...services.stats.overview(), devicesTotal: persistence.repo.count("devices") },
    ts: new Date().toISOString()
  });
  bus.subscribe("circulation.borrowed", (event) => { void publishKpi(event.branchId); }, { name: "kpi.circulation.borrowed" });
  bus.subscribe("circulation.returned", (event) => { void publishKpi(event.branchId); }, { name: "kpi.circulation.returned" });
  bus.subscribe("circulation.renewed", (event) => { void publishKpi(event.branchId); }, { name: "kpi.circulation.renewed" });
  bus.subscribe("gate.passed", (event) => { void publishKpi(event.branchId); }, { name: "kpi.gate" });
  bus.subscribe("alert.raised", (event) => { void publishKpi(event.branchId); }, { name: "kpi.alert.raised" });
  bus.subscribe("alert.acked", (event) => { void publishKpi(event.branchId); }, { name: "kpi.alert.acked" });
  bus.subscribe("alert.resolved", (event) => { void publishKpi(event.branchId); }, { name: "kpi.alert.resolved" });
  bus.subscribe("device.status_changed", (event) => { void publishKpi(event.branchId); }, { name: "kpi.device" });
  telemetryPipeline.start();

  app.use(express.json());
  app.use("/api/auth", createAuthRouter(persistence.repo));
  app.use("/api/health", healthRouter);
  app.get("/api/stream", requireAuth("librarian", "admin"), (req, res) => streamEvents(req, res, bus));
  app.get("/api/simulator/status", requireAuth("admin"), (_req, res) => res.json({ data: simulator.status() }));
  app.post("/api/simulator/start", requireAuth("admin"), (req, res) => {
    if (req.body?.speed !== undefined && typeof req.body.speed !== "number") return res.status(400).json({ code: "INVALID_SPEED", message: "speed must be a number" });
    try {
      res.json({ data: simulator.startControl(typeof req.body?.speed === "number" ? req.body.speed : undefined) });
    } catch (error) {
      res.status(400).json({ code: "INVALID_SPEED", message: error instanceof Error ? error.message : "Invalid speed" });
    }
  });
  app.post("/api/simulator/stop", requireAuth("admin"), (_req, res) => {
    void simulator.stop().then(() => res.json({ data: simulator.status() }));
  });
  app.patch("/api/simulator/speed", requireAuth("admin"), (req, res) => {
    if (typeof req.body?.speed !== "number") return res.status(400).json({ code: "INVALID_SPEED" });
    try {
      res.json({ data: simulator.setSpeed(req.body.speed) });
    } catch (error) {
      res.status(400).json({ code: "INVALID_SPEED", message: error instanceof Error ? error.message : "Invalid speed" });
    }
  });
  app.post("/api/simulator", requireAuth("admin"), (req, res) => {
    if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ code: "INVALID_ENABLED" });
    res.json({ data: simulator.setEnabled(req.body.enabled) });
  });
  app.post("/api/simulator/scenario", requireAuth("admin"), (req, res) => {
    const allowed = ["smoke_spike", "device_offline", "illegal_exit", "sensor_glitch", "network_outage", "overload", "recover"];
    if (!allowed.includes(req.body?.scenario)) return res.status(400).json({ code: "INVALID_SCENARIO" });
    const branchId = req.body?.branchId;
    if (branchId !== undefined && (typeof branchId !== "string" || branchId.trim() === "" || branchId.length > 128)) return res.status(400).json({ code: "INVALID_INPUT", message: "branchId must be a non-empty string.", details: null });
    void simulator.scenario(req.body.scenario, req.body.branchId)
      .then((data) => res.status(202).json({ data }))
      .catch((error: unknown) => res.status(400).json({ code: "SCENARIO_FAILED", message: error instanceof Error ? error.message : "Scenario failed" }));
  });
  app.use("/api/public", createPublicRouter(() => ({
    ...services.stats.overview(),
    loansToday: persistence.repo.count("loans", "borrowed_at >= date('now') AND status IN ('active','returned','overdue')")
  })));
  app.use("/api", createLibraryRouter(services, { telemetryPipeline }));
  // Malformed JSON bodies get the same error shape as schema failures instead of Express's HTML page.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const type = (error as { type?: string } | null)?.type;
    if (type === "entity.parse.failed" || type === "entity.too.large") {
      res.status(type === "entity.too.large" ? 413 : 400).json({ code: "INVALID_INPUT", message: "Request body is invalid.", details: null });
      return;
    }
    res.status(500).json({ code: "INTERNAL_ERROR", message: "The server could not complete the request.", details: null });
  });

  app.locals.persistence = persistence;
  app.locals.services = services;
  app.locals.events = bus;
  app.locals.simulator = simulator;
  app.locals.alertRules = rules;
  app.locals.telemetryPipeline = telemetryPipeline;
  if (simulatorAutostart) simulator.start();

  return app;
}
