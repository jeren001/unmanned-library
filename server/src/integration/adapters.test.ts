import { describe, expect, it } from "vitest";
import { DeviceAdapterFactory } from "./factory.js";
import type { DeviceAdapter, DeviceRecord } from "./types.js";

const devices: DeviceRecord[] = [
  { id: "tcp-rfid", branch_id: "b", kind: "rfid_reader", name: "RFID", vendor: "v", protocol: "tcp", address: "x", status: "online" },
  { id: "http-camera", branch_id: "b", kind: "camera", name: "Camera", vendor: "v", protocol: "http", address: "x", status: "online" },
  { id: "http-sensor", branch_id: "b", kind: "smoke", name: "Sensor", vendor: "v", protocol: "http", address: "x", status: "online" },
  { id: "tcp-gate", branch_id: "b", kind: "gate", name: "Gate", vendor: "v", protocol: "tcp", address: "x", status: "online" },
  { id: "mock", branch_id: "b", kind: "kiosk", name: "Mock", vendor: "v", protocol: "mock", address: "x", status: "online" },
  { id: "legacy", branch_id: "b", kind: "shelf", name: "Legacy", vendor: "v", protocol: "legacy", address: "x", status: "online" }
];

describe("DeviceAdapterFactory", () => {
  it("creates adapters with the common contract", async () => {
    for (const device of devices) {
      const adapter: DeviceAdapter = new DeviceAdapterFactory().create(device);
      await adapter.connect();
      expect((await adapter.health()).status).toBe("online");
      expect(await adapter.read()).toBeTruthy();
      expect((await adapter.command("ping")).ok).toBe(device.protocol !== "legacy");
    }
  });
});
