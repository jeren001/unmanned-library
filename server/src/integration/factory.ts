import { GateControllerAdapter, HttpCameraAdapter, HttpSensorAdapter, LegacyPollingAdapter, MockAdapter, TcpRfidAdapter } from "./adapters.js";
import type { DeviceAdapter, DeviceRecord } from "./types.js";

export class DeviceAdapterFactory {
  create(device: DeviceRecord): DeviceAdapter {
    const protocol = device.protocol.toLowerCase();
    if (protocol === "legacy") return new LegacyPollingAdapter(device);
    if (protocol === "tcp") return device.kind === "gate" ? new GateControllerAdapter(device) : new TcpRfidAdapter(device);
    if (protocol === "http") return device.kind === "camera" ? new HttpCameraAdapter(device) : new HttpSensorAdapter(device);
    return new MockAdapter(device);
  }
}
