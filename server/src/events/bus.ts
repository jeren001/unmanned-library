import { Logger, rootLogger } from "./logger.js";
import type { EventEnvelope, EventMap, EventName } from "./types.js";

export type EventMeta = { seq: number; name: EventName; ts: string };
export type EventHandler<N extends EventName> = (payload: EventMap[N], meta: EventMeta) => void | Promise<void>;
export type SubscribeOptions = { name?: string };
export type HandlerStats = {
  handler: string;
  event: EventName | "*";
  invocations: number;
  failures: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  lastError?: string;
};

type Registration = {
  id: number;
  event: EventName | "*";
  name: string;
  handler: EventHandler<EventName>;
};

export class EventBus {
  private readonly registrations: Registration[] = [];
  private readonly statsMap = new Map<number, HandlerStats>();
  private readonly replay: EventEnvelope[] = [];
  private readonly logger: Logger;
  private sequence = 0;
  private nextId = 1;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: { logger?: Logger; replayBuffer?: number } = {}) {
    this.logger = options.logger ?? rootLogger.child("events");
    this.replayBuffer = options.replayBuffer ?? 200;
  }
  private readonly replayBuffer: number;

  subscribe<N extends EventName>(event: N, handler: EventHandler<N>, options: SubscribeOptions = {}) {
    return this.add(event, handler as EventHandler<EventName>, options);
  }
  subscribeAll(handler: EventHandler<EventName>, options: SubscribeOptions = {}) {
    return this.add("*", handler, options);
  }

  async publish<N extends EventName>(name: N, payload: EventMap[N]) {
    const envelope: EventEnvelope<N> = { seq: ++this.sequence, name, payload, ts: new Date().toISOString() };
    this.replay.push(envelope as EventEnvelope);
    if (this.replay.length > this.replayBuffer) this.replay.shift();
    const meta = { seq: envelope.seq, name, ts: envelope.ts };
    const targets = this.registrations.filter((item) => item.event === name || item.event === "*");
    let failures = 0;
    const work: Promise<void>[] = [];
    for (const target of targets) {
      const started = process.hrtime.bigint();
      const stats = this.statsMap.get(target.id)!;
      stats.invocations += 1;
      try {
        const result = target.handler(payload as EventMap[EventName], meta);
        if (result && typeof (result as Promise<void>).then === "function") {
          work.push(Promise.resolve(result).then(
            () => this.finish(target, stats, started),
            (error) => { failures += 1; this.fail(target, stats, started, error); }
          ));
        } else {
          this.finish(target, stats, started);
        }
      } catch (error) {
        failures += 1;
        this.fail(target, stats, started, error);
      }
    }
    const settled = Promise.all(work).then(() => undefined);
    this.pending = this.pending.then(() => settled).catch(() => undefined);
    await settled;
    return { seq: envelope.seq, delivered: targets.length - failures, failed: failures };
  }

  publishNoWait<N extends EventName>(name: N, payload: EventMap[N]) {
    void this.publish(name, payload);
    return this.sequence;
  }
  async idle() { await this.pending; }
  get lastSeq() { return this.sequence; }
  replaySince(afterSeq: number, limit = this.replayBuffer) {
    return this.replay.filter((event) => event.seq > afterSeq).slice(-limit);
  }
  stats() { return [...this.statsMap.values()].map((item) => ({ ...item })); }
  handlerCount() { return this.registrations.length; }
  clear() { this.registrations.length = 0; this.statsMap.clear(); }

  private add(event: EventName | "*", handler: EventHandler<EventName>, options: SubscribeOptions) {
    const id = this.nextId++;
    const name = options.name ?? handler.name ?? `handler-${id}`;
    const registration = { id, event, name, handler };
    this.registrations.push(registration);
    this.statsMap.set(id, { handler: name, event, invocations: 0, failures: 0, totalMs: 0, maxMs: 0, lastMs: 0 });
    return () => {
      const index = this.registrations.indexOf(registration);
      if (index >= 0) this.registrations.splice(index, 1);
      this.statsMap.delete(id);
    };
  }
  private finish(registration: Registration, stats: HandlerStats, started: bigint) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    stats.totalMs += ms; stats.lastMs = ms; stats.maxMs = Math.max(stats.maxMs, ms);
    this.logger.info("handler completed", { event: registration.event, handler: registration.name, durationMs: Number(ms.toFixed(3)) });
  }
  private fail(registration: Registration, stats: HandlerStats, started: bigint, error: unknown) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    stats.totalMs += ms; stats.lastMs = ms; stats.maxMs = Math.max(stats.maxMs, ms); stats.failures += 1;
    stats.lastError = error instanceof Error ? error.message : String(error);
    this.logger.error("handler failed (isolated)", { event: registration.event, handler: registration.name, durationMs: Number(ms.toFixed(3)), error: stats.lastError });
  }
}
