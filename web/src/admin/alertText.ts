type Translate = (key: string, options: Record<string, unknown>) => string;

const DEVICE_KINDS = ["kiosk", "rfid_reader", "gate", "camera", "temp_humidity", "light", "smoke", "pir", "shelf"];

/**
 * Seeded demo alerts carry English text ("Simulated 12 alert at East Campus Library"), so they are described from the
 * alert type in the UI language instead. Real alert messages are shown as written.
 */
export function alertMessage(t: Translate, alert: { type: string; message: string }, branch: string) {
  if (!alert.message.startsWith("Simulated")) return alert.message;
  return t(`admin.alertMessage.${alert.type}`, { branch, defaultValue: t("admin.alertMessage.other", { branch }) });
}

/**
 * "East Campus Library gate 3" → "闸机 3" / "Gate 3"; the branch is shown on its own. Without a `kind` (e.g. a joined
 * `device_name`), the kind is read from the seeded name ("… rfid reader 2"). Anything else stays as it is.
 */
export function deviceLabel(t: Translate, device: { kind?: string | null; name: string }) {
  const match = /(?:^|\s)([a-z]+(?: [a-z]+)?) (\d+)\s*$/.exec(device.name);
  const kind = device.kind ?? DEVICE_KINDS.find((item) => match?.[1]?.endsWith(item.replace("_", " ")));
  const number = /(\d+)\s*$/.exec(device.name)?.[1];
  return kind && number ? t(`admin.deviceLabel.${kind}`, { n: number, defaultValue: device.name }) : device.name;
}

/** Seeded maintenance records are titled "Maintenance work order 8"; show that in the UI language. Real titles stay as written. */
export function maintenanceTitle(t: Translate, description: string) {
  const number = /^Maintenance work order (\d+)$/.exec(description.trim())?.[1];
  return number ? t("admin.maintenanceTitle", { n: number }) : description;
}
