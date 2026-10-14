type Translate = (key: string, options: Record<string, unknown>) => string;

/**
 * Seeded demo alerts carry English text ("Simulated 12 alert at East Campus Library"), so they are described from the
 * alert type in the UI language instead. Real alert messages are shown as written.
 */
export function alertMessage(t: Translate, alert: { type: string; message: string }, branch: string) {
  if (!alert.message.startsWith("Simulated")) return alert.message;
  return t(`admin.alertMessage.${alert.type}`, { branch, defaultValue: t("admin.alertMessage.other", { branch }) });
}

/** "East Campus Library gate 3" → "闸机 3" / "Gate 3"; the branch is shown on its own. Names without a number stay as they are. */
export function deviceLabel(t: Translate, device: { kind: string; name: string }) {
  const number = /(\d+)\s*$/.exec(device.name)?.[1];
  return number ? t(`admin.deviceLabel.${device.kind}`, { n: number, defaultValue: device.name }) : device.name;
}
