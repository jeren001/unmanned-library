import type { Request, Response } from "express";
import type { EventBus } from "../events/bus.js";
import type { EventEnvelope, EventName } from "../events/types.js";

function branchOf(event: EventEnvelope, branchId?: string) {
  if (!branchId) return true;
  const payload = event.payload as { branchId?: string; branch_id?: string };
  return event.name === "kpi.updated" && !payload.branchId && !payload.branch_id
    ? true
    : payload.branchId === branchId || payload.branch_id === branchId;
}

export function streamEvents(req: Request, res: Response, bus: EventBus) {
  const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
  const topics = typeof req.query.topics === "string" ? new Set(req.query.topics.split(",") as EventName[]) : undefined;
  const requestedAfter = Number(req.header("Last-Event-ID") ?? req.query.after ?? 0);
  const after = Number.isFinite(requestedAfter) ? requestedAfter : 0;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const write = (event: EventEnvelope) => {
    if (topics && !topics.has(event.name)) return;
    if (!branchOf(event, branchId)) return;
    res.write(`id: ${event.seq}\nevent: ${event.name}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  };
  let replaying = true;
  const pending: EventEnvelope[] = [];
  const unsubscribe = bus.subscribeAll((payload, meta) => {
    const event: EventEnvelope = { seq: meta.seq, name: meta.name, payload, ts: meta.ts };
    if (replaying) pending.push(event);
    else write(event);
  }, { name: "api.sse" });
  for (const event of bus.replaySince(after)) write(event);
  replaying = false;
  for (const event of pending.sort((left, right) => left.seq - right.seq)) write(event);
  const heartbeat = setInterval(() => res.write(`: keepalive ${Date.now()}\n\n`), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
}
