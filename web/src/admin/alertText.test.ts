import { describe, expect, it } from "vitest";
import i18n from "../shared/i18n";
import { alertMessage, deviceLabel, maintenanceTitle } from "./alertText";

const t = (key: string, options: Record<string, unknown>) => i18n.t(key, options);

describe("seeded admin text", () => {
  it("shows seeded alerts, devices and work orders in the selected language", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(alertMessage(t, { type: "smoke", message: "Simulated 12 alert at East Campus Library" }, "校园东馆")).toBe("校园东馆检测到烟雾");
    expect(deviceLabel(t, { kind: "gate", name: "East Campus Library gate 3" })).toBe("闸机 3");
    expect(deviceLabel(t, { name: "East Campus Library rfid reader 2" })).toBe("RFID 读写器 2");
    expect(deviceLabel(t, { name: "West Study Pod temp humidity 5" })).toBe("温湿度传感器 5");
    expect(maintenanceTitle(t, "Maintenance work order 8")).toBe("维护工单 8");
    await i18n.changeLanguage("en");
    expect(deviceLabel(t, { name: "East Campus Library smoke 7" })).toBe("Smoke sensor 7");
    await i18n.changeLanguage("zh-CN");
  });

  it("leaves real text as written", () => {
    expect(alertMessage(t, { type: "smoke", message: "烟感 3 读数 9 ppm" }, "校园东馆")).toBe("烟感 3 读数 9 ppm");
    expect(deviceLabel(t, { name: "Front desk scanner" })).toBe("Front desk scanner");
    expect(deviceLabel(t, { name: "Unit 4" })).toBe("Unit 4");
    expect(maintenanceTitle(t, "更换闸机电机")).toBe("更换闸机电机");
  });
});
