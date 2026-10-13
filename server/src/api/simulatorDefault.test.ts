import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./server.js";
import type { LibrarySimulator } from "../simulator/index.js";

const original = process.env.SIMULATOR_ENABLED;
afterEach(() => {
  if (original === undefined) delete process.env.SIMULATOR_ENABLED;
  else process.env.SIMULATOR_ENABLED = original;
});

const simulatorOf = (app: ReturnType<typeof createServer>) => app.locals.simulator as LibrarySimulator;

describe("simulator start-up", () => {
  it("is off unless explicitly enabled", async () => {
    delete process.env.SIMULATOR_ENABLED;
    const simulator = simulatorOf(createServer(":memory:"));
    expect(simulator.status().running).toBe(false);
    // An admin pressing Start still works.
    expect(simulator.startControl().running).toBe(true);
    await simulator.stop();
  });

  it("starts with the server when SIMULATOR_ENABLED=true", async () => {
    process.env.SIMULATOR_ENABLED = "true";
    const simulator = simulatorOf(createServer(":memory:"));
    expect(simulator.status().running).toBe(true);
    await simulator.stop();
  });
});
