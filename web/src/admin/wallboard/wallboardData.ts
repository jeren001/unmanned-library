import type { LoanRow } from "../adminApi";

/* Pure helpers for the wallboard (kept free of React so they can be unit-tested). */

export type HourlyBuckets = { borrowed: number[]; returned: number[] };

function sameLocalDay(iso: string, now: Date) {
  const date = new Date(iso);
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

/** Today's borrows and returns per local hour (0–23). */
export function bucketHourly(loans: Pick<LoanRow, "borrowed_at" | "returned_at">[], now = new Date()): HourlyBuckets {
  const borrowed = Array<number>(24).fill(0);
  const returned = Array<number>(24).fill(0);
  for (const loan of loans) {
    if (loan.borrowed_at && sameLocalDay(loan.borrowed_at, now)) borrowed[new Date(loan.borrowed_at).getHours()] += 1;
    if (loan.returned_at && sameLocalDay(loan.returned_at, now)) returned[new Date(loan.returned_at).getHours()] += 1;
  }
  return { borrowed, returned };
}

export function addToHour(buckets: HourlyBuckets, kind: "borrowed" | "returned", iso: string, now = new Date()): HourlyBuckets {
  if (!sameLocalDay(iso, now)) return buckets;
  const series = [...buckets[kind]];
  series[new Date(iso).getHours()] += 1;
  return { ...buckets, [kind]: series };
}

export type EnvMetric = "temperature" | "humidity" | "light_lux" | "smoke_ppm" | "occupancy";
export const ENV_METRICS: EnvMetric[] = ["temperature", "humidity", "occupancy", "light_lux", "smoke_ppm"];
export const ENV_UNITS: Record<EnvMetric, string> = { temperature: "°C", humidity: "%", light_lux: "lx", smoke_ppm: "ppm", occupancy: "" };
export type Level = "ok" | "warn" | "critical";

/** Comfort / safety level for an environment reading. */
export function envLevel(metric: EnvMetric, value: number | undefined): Level {
  if (value === undefined || Number.isNaN(value)) return "ok";
  switch (metric) {
    case "temperature": return value < 16 || value > 30 ? "critical" : value < 18 || value > 26 ? "warn" : "ok";
    case "humidity": return value < 25 || value > 75 ? "critical" : value < 35 || value > 65 ? "warn" : "ok";
    case "light_lux": return value < 150 ? "warn" : "ok";
    case "smoke_ppm": return value >= 10 ? "critical" : value >= 6 ? "warn" : "ok";
    case "occupancy": return value >= 40 ? "critical" : value >= 30 ? "warn" : "ok";
  }
}

/** Keeps the last `size` points of a series. */
export function pushPoint(series: number[], value: number, size = 40) {
  const next = [...series, value];
  return next.length > size ? next.slice(next.length - size) : next;
}

/** SVG polyline points for a sparkline in a width x height box. */
export function sparklinePoints(values: number[], width = 100, height = 28) {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((value, index) => `${((index / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((value - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
}

/* ---------- Event flow ---------- */

export type FlowNode = "kiosk" | "sensors" | "bus" | "alerts" | "dashboard";
export type FlowEventName =
  | "circulation.borrowed" | "circulation.returned" | "circulation.renewed" | "gate.passed"
  | "telemetry.received" | "device.status_changed" | "alert.raised" | "alert.acked" | "kpi.updated";

/** Which hops a real event travels: source -> bus -> destination(s). */
export function flowRoute(name: FlowEventName): { from: FlowNode; to: FlowNode[] } {
  switch (name) {
    case "circulation.borrowed":
    case "circulation.returned":
    case "circulation.renewed":
      return { from: "kiosk", to: ["dashboard"] };
    case "gate.passed":
      return { from: "kiosk", to: ["dashboard"] };
    case "telemetry.received":
      return { from: "sensors", to: ["dashboard"] };
    case "device.status_changed":
      return { from: "sensors", to: ["alerts", "dashboard"] };
    case "alert.raised":
    case "alert.acked":
      return { from: "sensors", to: ["alerts"] };
    case "kpi.updated":
      return { from: "bus", to: ["dashboard"] };
  }
}

/* ---------- ECharts theme from CSS tokens ---------- */

export function readTokens(element: Element) {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    text: token("--text", "#F3E6D8"),
    text2: token("--text-2", "#C4AFA2"),
    line: token("--line", "#4A2A30"),
    surface: token("--surface", "#2A1418"),
    accent: token("--accent", "#E8566B"),
    blush: token("--blush", "#F4B6B0"),
    success: token("--success", "#5FBF8F"),
    wood: token("--wood", "#A35B33"),
    mono: token("--font-mono", "monospace"),
    sans: token("--font-sans", "sans-serif")
  };
}

export function echartsTheme(tokens: ReturnType<typeof readTokens>) {
  const axis = {
    axisLine: { lineStyle: { color: tokens.line } },
    axisTick: { lineStyle: { color: tokens.line } },
    axisLabel: { color: tokens.text2, fontFamily: tokens.mono },
    splitLine: { lineStyle: { color: tokens.line, type: "dashed" } }
  };
  return {
    color: [tokens.accent, tokens.blush, tokens.success, tokens.wood],
    backgroundColor: "transparent",
    textStyle: { color: tokens.text, fontFamily: tokens.sans },
    legend: { textStyle: { color: tokens.text2 } },
    tooltip: { backgroundColor: tokens.surface, borderColor: tokens.line, textStyle: { color: tokens.text } },
    categoryAxis: axis,
    valueAxis: axis
  };
}
