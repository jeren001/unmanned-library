import { randomUUID } from "node:crypto";
import type { EventBus } from "../events/bus.js";
import type { LibraryRepository } from "../persistence/repositories.js";
import type { GatePassedEvent, TelemetryReceivedEvent } from "../events/types.js";
import { TelemetryPipeline } from "../integration/telemetryPipeline.js";
import { CirculationService } from "../domain/circulationService.js";

export type Scenario = "smoke_spike" | "device_offline" | "illegal_exit" | "sensor_glitch" | "network_outage" | "overload" | "recover";
export type SimulatorOptions = { enabled?: boolean; intervalMs?: number; seed?: number };

export class LibrarySimulator {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private scenarioState = new Map<string, { scenario: Scenario; until: number }>();
  private readonly pipeline: TelemetryPipeline;
  private readonly ownsPipeline: boolean;
  private readonly circulation: CirculationService;
  private readonly heartbeats = new Map<string, number>();
  private readonly missedHeartbeats = new Map<string, number>();
  private randomState: number;
  constructor(private readonly repo: LibraryRepository, private readonly bus: EventBus, private readonly options: SimulatorOptions = {}, pipeline?: TelemetryPipeline) {
    this.pipeline = pipeline ?? new TelemetryPipeline(repo, bus);
    this.ownsPipeline = !pipeline;
    this.circulation = new CirculationService(repo, bus);
    this.randomState = options.seed ?? 42;
  }
  start() {
    if (this.running || this.options.enabled === false) return;
    this.running = true;
    this.pipeline.start();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 5_000);
    void this.tick();
  }
  setEnabled(enabled: boolean) {
    this.options.enabled = enabled;
    if (enabled) this.start();
    else void this.stop();
    return this.status();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
    if (this.ownsPipeline) this.pipeline.stop();
    await this.pipeline.flush();
  }
  async scenario(scenario: Scenario, branchId?: string) {
    const branch = branchId ?? String((this.repo.list("branches", { limit: 1 })[0] as { id: string } | undefined)?.id ?? "branch-east");
    this.scenarioState.set(branch, { scenario, until: Date.now() + (scenario === "recover" ? 0 : 30_000) });
    if (scenario === "overload") {
      const device = this.repo.list("devices", { branchId: branch, limit: 1 })[0] as { id: string } | undefined;
      if (!device) throw new Error(`No device configured for branch ${branch}`);
      for (let i = 0; i < 500; i += 1) this.pipeline.enqueue(this.sample(device.id, branch, `overload_${i}`));
      await this.pipeline.flush();
    } else if (scenario === "illegal_exit") {
      const device = this.repo.list("devices", { branchId: branch, limit: 200 })
        .find((row) => (row as { kind?: string }).kind === "gate") as { id: string } | undefined;
      if (!device) throw new Error(`No device configured for branch ${branch}`);
      const gateEvent: GatePassedEvent = {
        gateEventId: randomUUID(), branchId: branch, deviceId: device.id,
        direction: "out", rfidTags: [`RFID-UNKNOWN-${Date.now()}`], authorized: false, ts: new Date().toISOString()
      };
      this.repo.insertGateEvent({
        id: gateEvent.gateEventId, branch_id: gateEvent.branchId, device_id: gateEvent.deviceId,
        direction: gateEvent.direction, rfid_tags_json: JSON.stringify(gateEvent.rfidTags),
        authorized: 0, ts: gateEvent.ts
      });
      await this.bus.publish("gate.passed", gateEvent);
    } else if (scenario === "device_offline") {
      const device = this.repo.list("devices", { branchId: branch, limit: 1 })[0] as { id: string; status: "online" | "offline" | "fault"; name?: string; kind?: string } | undefined;
      if (device) {
        this.repo.update("devices", device.id, { status: "offline", last_seen_at: null });
        await this.bus.publish("device.status_changed", { deviceId: device.id, branchId: branch, name: device.name, kind: device.kind, from: device.status, to: "offline", reason: "scenario", ts: new Date().toISOString() });
      }
    } else if (scenario === "recover") {
      const devices = this.repo.list("devices", { branchId: branch, status: "offline", limit: 200 }) as Array<{ id: string; status: "offline"; name?: string; kind?: string }>;
      for (const device of devices) {
        this.repo.update("devices", device.id, { status: "online", last_seen_at: new Date().toISOString() });
        this.missedHeartbeats.delete(device.id);
        await this.bus.publish("device.status_changed", { deviceId: device.id, branchId: branch, name: device.name, kind: device.kind, from: "offline", to: "online", reason: "scenario_recover", ts: new Date().toISOString() });
      }
    }
    return { scenario, branchId: branch, queued: this.pipeline.size() };
  }
  status() {
    return { enabled: this.options.enabled !== false, running: this.running, queued: this.pipeline.size(), scenarios: Object.fromEntries(this.scenarioState) };
  }
  private async tick() {
    for (const branch of this.repo.list("branches", { limit: 200 }) as Array<{ id: string }>) {
      const current = this.scenarioState.get(branch.id);
      const devices = this.repo.list("devices", { branchId: branch.id, limit: 200 }) as Array<{ id: string; kind: string; status: string }>;
      const branchOutage = current?.scenario === "network_outage" && current.until > Date.now();
      for (const device of devices) {
        if (device.status === "offline" || branchOutage) {
          const missed = (this.missedHeartbeats.get(device.id) ?? 0) + 1;
          this.missedHeartbeats.set(device.id, missed);
          if (missed === 3 && device.status !== "offline") {
            this.repo.update("devices", device.id, { status: "offline", last_seen_at: null });
            await this.bus.publish("device.status_changed", {
              deviceId: device.id, branchId: branch.id, from: "online", to: "offline", reason: branchOutage ? "network_outage" : "missed_heartbeat", ts: new Date().toISOString(), missedIntervals: missed
            });
          }
          continue;
        }
        this.missedHeartbeats.set(device.id, 0);
        const heartbeatAt = new Date().toISOString();
        this.repo.update("devices", device.id, { last_seen_at: heartbeatAt });
        const metrics: Array<[string, number]> = device.kind === "temp_humidity" ? [["temperature", this.temperatureValue()], ["humidity", 30 + this.random() * 40]] :
          device.kind === "light" ? [["light_lux", this.lightValue()]] : device.kind === "pir" ? [["occupancy", Math.floor(this.random() * 30)], ["headcount", Math.floor(this.random() * 30)]] :
          device.kind === "smoke" ? [["smoke_ppm", current?.scenario === "smoke_spike" ? 20 : this.random() * 4]] : [["heartbeat", 1]];
        for (const [metric, raw] of metrics) {
          const value = current?.scenario === "sensor_glitch" ? 999999 : Number(raw);
          this.pipeline.enqueue({ deviceId: device.id, branchId: branch.id, metric, value, quality: value > 100000 ? "dirty" : "ok", ts: new Date().toISOString(), source: "simulator" });
        }
        this.heartbeats.set(device.id, Date.now());
      }
      await this.simulateCirculation(branch.id);
      const gateDevice = devices.find((device) => device.kind === "gate") ?? devices[0];
      if (!gateDevice) continue;
      const gate: import("../events/types.js").GatePassedEvent = {
        gateEventId: randomUUID(), branchId: branch.id, deviceId: gateDevice.id,
        direction: this.random() > 0.5 ? "in" : "out", rfidTags: [`RFID-${Math.floor(this.random() * 300) + 1}`],
        authorized: true, ts: new Date().toISOString()
      };
      this.repo.insertGateEvent({ id: gate.gateEventId, branch_id: gate.branchId, device_id: gate.deviceId, direction: gate.direction, rfid_tags_json: JSON.stringify(gate.rfidTags), authorized: gate.authorized ? 1 : 0, ts: gate.ts });
      await this.bus.publish("gate.passed", gate);
    }
  }
  private async simulateCirculation(branchId: string) {
    if (this.random() > 0.35) return;
    const users = this.repo.list("users", { limit: 200, q: "reader" }) as Array<{ id: string; role: string; status: string }>;
    const user = users.find((row) => row.role === "reader" && row.status === "active");
    const book = this.repo.list("books", { branchId, status: "on_shelf", limit: 200 })[0] as { id: string } | undefined;
    if (!user || !book) return;
    try {
      const loan = this.circulation.borrow({ bookId: book.id, userId: user.id, branchId, idempotencyKey: `sim-${randomUUID()}` }) as { id: string };
      if (this.random() > 0.45) this.circulation.returnLoan({ loanId: loan.id });
    } catch {
      // Simulated traffic is best-effort. A full loan quota or a concurrent
      // state transition must not terminate the device/simulator process.
    }
  }
  private sample(deviceId: string, branchId: string, metric: string): TelemetryReceivedEvent {
    return { deviceId, branchId, metric, value: 22 + this.random() * 4, quality: "ok", ts: new Date().toISOString(), source: "simulator" };
  }
  private random() { this.randomState = (1664525 * this.randomState + 1013904223) >>> 0; return this.randomState / 0x1_0000_0000; }
  private lightValue() { const hour = new Date().getHours(); return hour >= 8 && hour <= 18 ? 200 + this.random() * 600 : 20 + this.random() * 80; }
  private temperatureValue() {
    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    const daily = Math.sin(((hour - 8) / 24) * Math.PI * 2);
    return 23 + daily * 4 + (this.random() - 0.5) * 1.5;
  }
}
