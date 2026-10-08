import type { LibraryRepository } from "../persistence/repositories.js";
import type { EventBus } from "../events/bus.js";
import type { TelemetryReceivedEvent } from "../events/types.js";

export class TelemetryPipeline {
  private readonly queue: Array<Omit<TelemetryReceivedEvent, "quality"> & { quality?: TelemetryReceivedEvent["quality"] }> = [];
  private readonly previous = new Map<string, { value: number; ts: number }>();
  private timer: NodeJS.Timeout | undefined;
  private rollupTimer: NodeJS.Timeout | undefined;
  private processing = false;
  constructor(
    private readonly repo: LibraryRepository,
    private readonly bus: EventBus,
    private readonly intervalMs = 500,
    private readonly rollupIntervalMs = 60 * 60 * 1000
  ) {}
  start() {
    this.timer ??= setInterval(() => void this.flush(), this.intervalMs);
    this.rollupTimer ??= setInterval(() => this.rollup(), this.rollupIntervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.rollupTimer) clearInterval(this.rollupTimer);
    this.timer = undefined;
    this.rollupTimer = undefined;
  }
  enqueue(event: Omit<TelemetryReceivedEvent, "quality"> & { quality?: TelemetryReceivedEvent["quality"] }) {
    this.queue.push(event);
  }
  size() { return this.queue.length; }
  async flush() {
    if (this.processing || this.queue.length === 0) return 0;
    this.processing = true;
    const batch = this.queue.splice(0, this.queue.length);
    let processed = 0;
    try {
      for (let index = 0; index < batch.length; index += 1) {
        const item = batch[index]!;
        const quality = item.quality === "dirty" ? "dirty" : this.quality(item);
        const row = this.repo.ingestTelemetry({
          device_id: item.deviceId, branch_id: item.branchId, metric: item.metric,
          value: item.value, quality, ts: item.ts
        });
        processed = index + 1;
        await this.bus.publish("telemetry.received", { ...item, quality, sampleId: String((row as { id?: string }).id ?? item.sampleId ?? "") });
      }
      return batch.length;
    } catch (error) {
      // Keep the unprocessed tail queued. Samples already committed are not
      // replayed, so a transient write failure cannot duplicate telemetry.
      this.queue.unshift(...batch.slice(processed));
      throw error;
    } finally { this.processing = false; }
  }
  private quality(item: Omit<TelemetryReceivedEvent, "quality"> & { quality?: TelemetryReceivedEvent["quality"] }): "ok" | "suspect" | "dirty" {
    if (!Number.isFinite(item.value) || Math.abs(item.value) > 100000) return "dirty";
    const ranges: Record<string, { min: number; max: number; jump: number }> = {
      temperature: { min: -30, max: 60, jump: 15 },
      humidity: { min: 0, max: 100, jump: 50 },
      light_lux: { min: 0, max: 100_000, jump: 5_000 },
      smoke_ppm: { min: 0, max: 1_000, jump: 50 },
      occupancy: { min: 0, max: 10_000, jump: 5_000 },
      headcount: { min: 0, max: 10_000, jump: 5_000 },
      heartbeat: { min: 0, max: 1, jump: 1 }
    };
    const range = ranges[item.metric];
    if (range && (item.value < range.min || item.value > range.max)) return "suspect";
    const key = `${item.deviceId}:${item.metric}`;
    const previous = this.previous.get(key);
    const currentTs = Date.parse(item.ts);
    let quality: "ok" | "suspect" = "ok";
    if (!Number.isFinite(currentTs) || (previous && currentTs <= previous.ts)) quality = "suspect";
    if (previous && range && Math.abs(item.value - previous.value) > range.jump) quality = "suspect";
    if (Number.isFinite(currentTs) && Date.now() - currentTs > 24 * 60 * 60 * 1000) quality = "suspect";
    this.previous.set(key, { value: item.value, ts: Number.isFinite(currentTs) ? currentTs : Date.now() });
    return quality;
  }
  rollup() {
    this.repo.rollupTelemetry();
  }
}
