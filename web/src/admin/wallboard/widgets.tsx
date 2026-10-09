import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { animate, easing, usePrefersReducedMotion } from "../../shared/motion";
import type { AlertFull, DeviceRow } from "../adminApi";
import { RelativeTime } from "../adminUi";
import { ENV_UNITS, envLevel, sparklinePoints, type EnvMetric, type FlowNode } from "./wallboardData";

/* ---------- Rolling (odometer) number ---------- */

/** Each digit rolls to its new value like an odometer; plain text under reduced motion. */
export function RollingNumber({ value, suffix = "" }: { value: number | null; suffix?: string }) {
  if (value === null) return <span className="wb-rolling is-empty">—</span>;
  const text = Math.round(value).toLocaleString("en-US");
  return (
    <span className="wb-rolling" aria-label={`${text}${suffix}`}>
      {[...text].map((char, index) => /\d/.test(char)
        ? <span key={text.length - index} className="wb-digit" aria-hidden="true"><span style={{ transform: `translateY(-${Number(char) * 10}%)` }}>{"0123456789".split("").map((digit) => <i key={digit}>{digit}</i>)}</span></span>
        : <span key={`sep-${text.length - index}`} className="wb-sep" aria-hidden="true">{char}</span>)}
      {suffix ? <small aria-hidden="true">{suffix}</small> : null}
    </span>
  );
}

export function Sparkline({ values, tone = "accent" }: { values: number[]; tone?: "accent" | "success" | "warn" | "critical" }) {
  const points = sparklinePoints(values, 100, 28);
  return (
    <svg className={`wb-spark is-${tone}`} viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      {points ? <><polyline points={`0,28 ${points} 100,28`} className="wb-spark-fill" /><polyline points={points} className="wb-spark-line" /></> : <line x1="0" y1="26" x2="100" y2="26" className="wb-spark-line is-flat" />}
    </svg>
  );
}

export function KpiCard({ label, scope, value, suffix, history, tone }: { label: string; scope: string; value: number | null; suffix?: string; history: number[]; tone?: "accent" | "success" | "warn" | "critical" }) {
  return (
    <article className={`wb-kpi is-${tone ?? "accent"}`}>
      <header><span>{label}</span><small>{scope}</small></header>
      <b><RollingNumber value={value} suffix={suffix} /></b>
      <Sparkline values={history} tone={tone} />
    </article>
  );
}

/* ---------- Environment ---------- */

export function EnvTile({ metric, value, history }: { metric: EnvMetric; value: number | undefined; history: number[] }) {
  const { t } = useTranslation();
  const level = envLevel(metric, value);
  const shown = value === undefined ? "—" : metric === "occupancy" || metric === "light_lux" ? Math.round(value).toString() : value.toFixed(1);
  return (
    <div className={`wb-env is-${level}`}>
      <span className="wb-env-label">{t(`admin.wallboard.env.${metric}`)}</span>
      <b className="mono">{shown}<small>{value === undefined ? "" : ENV_UNITS[metric]}</small></b>
      <span className="wb-env-level">{t(`admin.wallboard.level.${level}`)}</span>
      <Sparkline values={history} tone={level === "ok" ? "success" : level} />
    </div>
  );
}

/* ---------- Device matrix ---------- */

export function DeviceMatrix({ devices, changed }: { devices: DeviceRow[]; changed: Record<string, number> }) {
  const { t } = useTranslation();
  const kinds = [...new Set(devices.map((device) => device.kind))].sort();
  if (!devices.length) return <p className="wb-empty">{t("admin.wallboard.noDevices")}</p>;
  return (
    <div className="wb-matrix">
      {kinds.map((kind) => {
        const row = devices.filter((device) => device.kind === kind);
        return (
          <div key={kind} className="wb-matrix-row">
            <span className="wb-matrix-kind">{t(`admin.deviceKind.${kind}`, { defaultValue: kind })}</span>
            <div className="wb-matrix-cells">
              {row.map((device) => <MatrixCell key={device.id} device={device} flash={changed[device.id]} />)}
            </div>
            <span className="wb-matrix-count mono">{row.filter((device) => device.status === "online").length}/{row.length}</span>
          </div>
        );
      })}
    </div>
  );
}

function MatrixCell({ device, flash }: { device: DeviceRow; flash?: number }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!flash) return;
    const animation = animate(ref.current, [{ transform: "scale(1.6)", boxShadow: "0 0 0 6px rgba(244, 182, 176, .6)" }, { transform: "none", boxShadow: "0 0 0 0 rgba(244, 182, 176, 0)" }], { duration: 900, easing: easing.out });
    return () => animation?.cancel();
  }, [flash]);
  return <span ref={ref} className={`wb-cell is-${device.status}`} title={`${device.name} · ${t(`admin.deviceStatus.${device.status}`)}`} role="img" aria-label={`${device.name}: ${t(`admin.deviceStatus.${device.status}`)}`} />;
}

/* ---------- Alert feed ---------- */

export function AlertFeed({ alerts, fresh, devices, onAck, busyId }: { alerts: AlertFull[]; fresh: Set<string>; devices: Map<string, DeviceRow>; onAck: (alert: AlertFull) => void; busyId: string | null }) {
  const { t } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const listRef = useRef<HTMLOListElement>(null);
  const paused = useRef(false);

  // Slow auto-scroll when the feed overflows; pauses on hover/focus and under reduced motion.
  useEffect(() => {
    if (reduced) return;
    const list = listRef.current;
    if (!list) return;
    let hold = 0;
    const timer = window.setInterval(() => {
      if (paused.current || list.scrollHeight <= list.clientHeight + 2) return;
      if (hold > 0) { hold -= 1; return; }
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 1) {
        hold = 60;
        list.scrollTop = 0;
        return;
      }
      list.scrollTop += 1;
    }, 50);
    return () => window.clearInterval(timer);
  }, [reduced]);

  if (!alerts.length) return <p className="wb-empty">{t("admin.wallboard.noAlerts")}</p>;
  return (
    <ol
      ref={listRef}
      className="wb-feed"
      aria-live="polite"
      onMouseEnter={() => { paused.current = true; }}
      onMouseLeave={() => { paused.current = false; }}
      onFocus={() => { paused.current = true; }}
      onBlur={() => { paused.current = false; }}
    >
      {alerts.map((alert) => <FeedItem key={alert.id} alert={alert} fresh={fresh.has(alert.id)} device={alert.device_id ? devices.get(alert.device_id) : undefined} onAck={onAck} busy={busyId === alert.id} />)}
    </ol>
  );
}

function FeedItem({ alert, fresh, device, onAck, busy }: { alert: AlertFull; fresh: boolean; device?: DeviceRow; onAck: (alert: AlertFull) => void; busy: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    if (!fresh) return;
    const animation = animate(ref.current, [{ opacity: 0, transform: "translateX(40px)" }, { opacity: 1, transform: "none" }], { duration: 600, easing: easing.spring });
    return () => animation?.cancel();
  }, [fresh]);
  const pulsing = alert.severity === "critical" && alert.status === "open";
  return (
    <li ref={ref} className={`wb-alert is-${alert.severity} is-${alert.status} ${pulsing ? "is-pulsing" : ""}`}>
      <span className="wb-alert-sev">{t(`admin.severity.${alert.severity}`)}</span>
      <div>
        <b>{alert.message}</b>
        <small>{t(`admin.alertType.${alert.type}`, { defaultValue: alert.type })}{device ? ` · ${device.name}` : ""} · <RelativeTime value={alert.created_at} /></small>
      </div>
      {alert.status === "open"
        ? <button type="button" onClick={() => onAck(alert)} disabled={busy}>{t("admin.alertsPage.ack")}</button>
        : <span className="wb-alert-state">{t(`admin.alertStatus.${alert.status}`)}</span>}
    </li>
  );
}

/* ---------- Event flow strip ---------- */

const NODE_POS: Record<FlowNode, { x: number; y: number }> = {
  kiosk: { x: 70, y: 40 },
  sensors: { x: 70, y: 120 },
  bus: { x: 330, y: 80 },
  alerts: { x: 590, y: 40 },
  dashboard: { x: 590, y: 120 }
};

function segment(from: FlowNode, to: FlowNode) {
  const a = NODE_POS[from];
  const b = NODE_POS[to];
  const mid = (a.x + b.x) / 2;
  return `M${a.x + 52} ${a.y} C${mid} ${a.y} ${mid} ${b.y} ${b.x - 52} ${b.y}`;
}

const LINKS: Array<[FlowNode, FlowNode]> = [["kiosk", "bus"], ["sensors", "bus"], ["bus", "alerts"], ["bus", "dashboard"]];

export type EventFlowHandle = { pulse: (from: FlowNode, to: FlowNode[], tone: "accent" | "alert" | "info") => void };
type Dot = { id: number; path: string; tone: string; delay: number };

/** kiosk / sensors -> event bus -> alerts / dashboard; a dot travels for each real event. */
export const EventFlow = forwardRef<EventFlowHandle, { counts: Record<FlowNode, number> }>(function EventFlow({ counts }, ref) {
  const { t } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const [dots, setDots] = useState<Dot[]>([]);
  const [lit, setLit] = useState<Partial<Record<FlowNode, number>>>({});
  const nextId = useRef(1);

  useImperativeHandle(ref, () => ({
    pulse(from, to, tone) {
      const now = Date.now();
      setLit((value) => ({ ...value, [from]: now, bus: now, ...Object.fromEntries(to.map((node) => [node, now + 1])) }));
      if (reduced) return;
      const hops: Dot[] = [];
      if (from !== "bus") hops.push({ id: nextId.current++, path: segment(from, "bus"), tone, delay: 0 });
      for (const node of to) hops.push({ id: nextId.current++, path: segment("bus", node), tone, delay: from === "bus" ? 0 : 700 });
      setDots((value) => [...value.slice(-40), ...hops]);
      const ids = new Set(hops.map((hop) => hop.id));
      window.setTimeout(() => setDots((value) => value.filter((dot) => !ids.has(dot.id))), 1700);
    }
  }), [reduced]);

  return (
    <svg className="wb-flow" viewBox="0 0 660 160" role="img" aria-label={t("admin.wallboard.flowLabel")}>
      {LINKS.map(([from, to]) => <path key={`${from}-${to}`} d={segment(from, to)} className="wb-flow-link" />)}
      {(Object.keys(NODE_POS) as FlowNode[]).map((node) => {
        const pos = NODE_POS[node];
        return (
          <g key={node} className={`wb-flow-node ${node === "bus" ? "is-bus" : ""}`} transform={`translate(${pos.x} ${pos.y})`}>
            <rect x="-52" y="-22" width="104" height="44" rx="10" />
            {lit[node] ? <rect key={lit[node]} className="wb-flow-flash" x="-52" y="-22" width="104" height="44" rx="10" /> : null}
            <text y="-3" textAnchor="middle">{t(`admin.wallboard.node.${node}`)}</text>
            <text y="13" textAnchor="middle" className="wb-flow-count">{counts[node]}</text>
          </g>
        );
      })}
      {dots.map((dot) => <FlowDot key={dot.id} dot={dot} />)}
    </svg>
  );
});

function FlowDot({ dot }: { dot: Dot }) {
  const motion = useRef<SVGAnimateMotionElement>(null);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setStarted(true), dot.delay);
    return () => window.clearTimeout(timer);
  }, [dot.delay]);
  // SMIL timing is relative to page load, so each hop is started explicitly.
  useEffect(() => {
    if (started) motion.current?.beginElement();
  }, [started]);
  return (
    <circle r="5" className={`wb-flow-dot is-${dot.tone}`} opacity={started ? 1 : 0}>
      <animateMotion ref={motion} begin="indefinite" dur="0.8s" fill="freeze" path={dot.path} />
    </circle>
  );
}
