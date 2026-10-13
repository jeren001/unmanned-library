import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { useToast } from "../../shared/components";
import {
  ackAlert, api, fetchAlerts, fetchBranches, fetchDeviceIndex, fetchOverview, logout,
  type AlertFull, type Branch, type DeviceRow, type DeviceStatus, type LoanRow, type Overview
} from "../adminApi";
import { errorText } from "../adminUi";
import { HourlyChart } from "./HourlyChart";
import {
  addToHour, bucketHourly, ENV_METRICS, flowRoute, pushPoint,
  type EnvMetric, type FlowEventName, type FlowNode, type HourlyBuckets
} from "./wallboardData";
import { AlertFeed, DeviceMatrix, EnvTile, EventFlow, KpiCard, type EventFlowHandle } from "./widgets";
import "./wallboard.css";

type Connection = "connecting" | "live" | "reconnecting" | "offline";
type EnvState = Record<EnvMetric, { byDevice: Record<string, number>; history: number[] }>;
type KpiKey = "activeLoans" | "todayBorrowed" | "openAlerts" | "devicesOnline" | "occupancy" | "books";

const POLL_MS = 30_000;
const SAMPLE_MS = 15_000;
const EVENTS: FlowEventName[] = ["circulation.borrowed", "circulation.returned", "circulation.renewed", "gate.passed", "telemetry.received", "device.status_changed", "alert.raised", "alert.acked", "kpi.updated"];

const emptyEnv = (): EnvState => Object.fromEntries(ENV_METRICS.map((metric) => [metric, { byDevice: {}, history: [] }])) as unknown as EnvState;
const emptyFlow = (): Record<FlowNode, number> => ({ kiosk: 0, sensors: 0, bus: 0, alerts: 0, dashboard: 0 });

function aggregate(metric: EnvMetric, byDevice: Record<string, number>) {
  const values = Object.values(byDevice);
  if (!values.length) return undefined;
  const sum = values.reduce((total, value) => total + value, 0);
  return metric === "occupancy" ? sum : sum / values.length;
}

function sortFeed(alerts: AlertFull[]) {
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return [...alerts].sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || rank[a.severity] - rank[b.severity] || b.created_at.localeCompare(a.created_at));
}

async function fetchTodayLoans(branchId: string) {
  const params = new URLSearchParams({ limit: "200" });
  if (branchId !== "all") params.set("branchId", branchId);
  const { data } = await api<{ data: LoanRow[] }>(`/api/loans?${params.toString()}`);
  return bucketHourly(data);
}

async function fetchEnvironment(branchId: string): Promise<EnvState> {
  const env = emptyEnv();
  if (branchId === "all") return env;
  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await Promise.all(ENV_METRICS.map(async (metric) => {
    const params = new URLSearchParams({ branchId, metric, from });
    const { data } = await api<{ data: Array<{ device_id: string; value: number; quality?: string }> }>(`/api/telemetry?${params.toString()}`).catch(() => ({ data: [] }));
    for (const row of data) {
      if (row.quality === "dirty") continue;
      env[metric].byDevice[row.device_id] = row.value;
      const value = aggregate(metric, env[metric].byDevice);
      if (value !== undefined) env[metric].history = pushPoint(env[metric].history, value);
    }
  }));
  return env;
}

export function WallboardPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<EventFlowHandle>(null);
  const [now, setNow] = useState(() => new Date());
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("all");
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [buckets, setBuckets] = useState<HourlyBuckets>(() => bucketHourly([]));
  const [env, setEnv] = useState<EnvState>(emptyEnv);
  const [devices, setDevices] = useState<Map<string, DeviceRow>>(new Map());
  const [deviceFlash, setDeviceFlash] = useState<Record<string, number>>({});
  const [alerts, setAlerts] = useState<AlertFull[]>([]);
  const [freshAlerts, setFreshAlerts] = useState<Set<string>>(new Set());
  const [busyAlert, setBusyAlert] = useState<string | null>(null);
  const [flowCounts, setFlowCounts] = useState(emptyFlow);
  const [history, setHistory] = useState<Record<KpiKey, number[]>>({ activeLoans: [], todayBorrowed: [], openAlerts: [], devicesOnline: [], occupancy: [], books: [] });
  const lastTelemetryPulse = useRef(0);
  const alertTimer = useRef<number | undefined>(undefined);

  /* ---------- Loading ---------- */

  const loadAlerts = useCallback(async (markFresh?: string) => {
    const [open, acked] = await Promise.all([fetchAlerts("open", branchId), fetchAlerts("acked", branchId)]);
    setAlerts(sortFeed([...open, ...acked]));
    if (markFresh) setFreshAlerts(new Set([markFresh]));
  }, [branchId]);

  const loadAll = useCallback(() => {
    void fetchOverview().then(setOverview).catch(() => undefined);
    void fetchTodayLoans(branchId).then(setBuckets).catch(() => undefined);
    void fetchDeviceIndex(branchId, true).then(setDevices).catch(() => undefined);
    void loadAlerts().catch(() => undefined);
  }, [branchId, loadAlerts]);

  useEffect(() => {
    void fetchBranches().then((list) => {
      setBranches(list);
      setBranchId((current) => (current === "all" && list.length ? list[0].id : current));
    }).catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    setEnv(emptyEnv());
    setFlowCounts(emptyFlow());
    loadAll();
    void fetchEnvironment(branchId).then(setEnv).catch(() => undefined);
    const poll = window.setInterval(loadAll, POLL_MS);
    return () => window.clearInterval(poll);
  }, [branchId, loadAll]);

  /* ---------- Live stream ---------- */

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setConnection("offline");
      return;
    }
    setConnection("connecting");
    const stream = new EventSource(`/api/stream${branchId === "all" ? "" : `?branchId=${encodeURIComponent(branchId)}`}`, { withCredentials: true });
    stream.onopen = () => setConnection("live");
    stream.onerror = () => setConnection(stream.readyState === EventSource.CLOSED ? "offline" : "reconnecting");

    const pulse = (name: FlowEventName) => {
      const route = flowRoute(name);
      setFlowCounts((counts) => {
        const next = { ...counts, [route.from]: counts[route.from] + 1, bus: counts.bus + (route.from === "bus" ? 0 : 1) };
        for (const node of route.to) next[node] += 1;
        return next;
      });
      if (name === "telemetry.received") {
        // Telemetry is frequent: draw at most two dots per second for it.
        if (Date.now() - lastTelemetryPulse.current < 500) return;
        lastTelemetryPulse.current = Date.now();
      }
      flowRef.current?.pulse(route.from, route.to, name.startsWith("alert") ? "alert" : name === "telemetry.received" ? "info" : "accent");
    };

    const handle = (name: FlowEventName, payload: Record<string, unknown>) => {
      setLastEventAt(Date.now());
      setConnection("live");
      pulse(name);
      switch (name) {
        case "kpi.updated": {
          const stats = payload.stats as Overview | undefined;
          if (stats) setOverview(stats);
          break;
        }
        case "circulation.borrowed":
        case "circulation.returned":
          setBuckets((value) => addToHour(value, name === "circulation.borrowed" ? "borrowed" : "returned", String(payload.ts ?? new Date().toISOString())));
          break;
        case "telemetry.received": {
          const metric = payload.metric as EnvMetric;
          if (!ENV_METRICS.includes(metric) || payload.quality === "dirty") break;
          setEnv((value) => {
            const byDevice = { ...value[metric].byDevice, [String(payload.deviceId)]: Number(payload.value) };
            const aggregated = aggregate(metric, byDevice);
            return { ...value, [metric]: { byDevice, history: aggregated === undefined ? value[metric].history : pushPoint(value[metric].history, aggregated) } };
          });
          break;
        }
        case "device.status_changed": {
          const id = String(payload.deviceId);
          setDevices((value) => {
            const device = value.get(id);
            if (!device) return value;
            const next = new Map(value);
            next.set(id, { ...device, status: payload.to as DeviceStatus, last_seen_at: payload.to === "online" ? String(payload.ts) : device.last_seen_at });
            return next;
          });
          setDeviceFlash((value) => ({ ...value, [id]: Date.now() }));
          break;
        }
        case "alert.raised":
          if (payload.duplicate) break;
          window.clearTimeout(alertTimer.current);
          alertTimer.current = window.setTimeout(() => void loadAlerts(String(payload.alertId)).catch(() => undefined), 200);
          break;
        case "alert.acked":
          setAlerts((value) => sortFeed(value.map((alert) => (alert.id === payload.alertId ? { ...alert, status: "acked" } : alert))));
          break;
        default:
          break;
      }
    };

    const listeners = EVENTS.map((name) => {
      const listener = (event: Event) => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          // Still counts as an event.
        }
        handle(name, payload);
      };
      stream.addEventListener(name, listener);
      return listener;
    });
    return () => {
      EVENTS.forEach((name, index) => stream.removeEventListener(name, listeners[index]));
      stream.close();
      window.clearTimeout(alertTimer.current);
    };
  }, [branchId, loadAlerts]);

  /* ---------- Derived KPIs and their sparklines ---------- */

  const deviceList = useMemo(() => [...devices.values()], [devices]);
  const online = deviceList.filter((device) => device.status === "online").length;
  const openAlerts = alerts.filter((alert) => alert.status === "open");
  const kpis: Record<KpiKey, number | null> = {
    activeLoans: overview?.activeLoans ?? null,
    todayBorrowed: buckets.borrowed.reduce((sum, value) => sum + value, 0),
    openAlerts: openAlerts.length,
    devicesOnline: deviceList.length ? online : null,
    occupancy: aggregate("occupancy", env.occupancy.byDevice) ?? null,
    books: overview?.books ?? null
  };
  const kpiRef = useRef(kpis);
  kpiRef.current = kpis;

  useEffect(() => {
    const sample = () => setHistory((value) => {
      const next = { ...value };
      for (const key of Object.keys(next) as KpiKey[]) {
        const current = kpiRef.current[key];
        if (current !== null) next[key] = pushPoint(next[key], current, 30);
      }
      return next;
    });
    // A new branch is a new scope: start the sparklines afresh.
    setHistory({ activeLoans: [], todayBorrowed: [], openAlerts: [], devicesOnline: [], occupancy: [], books: [] });
    const first = window.setTimeout(sample, 2000);
    const timer = window.setInterval(sample, SAMPLE_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [branchId]);

  /* ---------- Clock and keyboard ---------- */

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const cycleBranch = useCallback(() => {
    const order = [...branches.map((branch) => branch.id), "all"];
    setBranchId((current) => order[(order.indexOf(current) + 1) % order.length]);
  }, [branches]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void (rootRef.current ?? document.documentElement).requestFullscreen?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || event.altKey || (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key === "f") { event.preventDefault(); toggleFullscreen(); }
      if (key === "b") { event.preventDefault(); cycleBranch(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen, cycleBranch]);

  async function acknowledge(alert: AlertFull) {
    setBusyAlert(alert.id);
    try {
      await ackAlert(alert.id);
      setAlerts((value) => sortFeed(value.map((item) => (item.id === alert.id ? { ...item, status: "acked" } : item))));
    } catch (error) {
      toast({ tone: "alert", title: t("admin.error.title"), body: errorText(t, error) });
    } finally {
      setBusyAlert(null);
    }
  }

  const branchLabel = (id: string) => {
    if (id === "all") return t("admin.allBranches");
    const branch = branches.find((item) => item.id === id);
    return branch ? (i18n.language === "en" ? branch.name_en : branch.name_zh) : id;
  };
  const scopeBranch = branchLabel(branchId);
  const scopeAll = t("admin.allBranches");
  const sinceEvent = lastEventAt ? Math.max(0, Math.round((now.getTime() - lastEventAt) / 1000)) : null;
  const hasCritical = openAlerts.some((alert) => alert.severity === "critical");

  async function signOut() {
    try {
      await logout();
    } catch {
      // The session may already be gone; leave the wallboard either way.
    }
    navigate("/login", { replace: true });
  }

  return (
    <div ref={rootRef} className="wb-root" data-theme="wallboard">
      <header className="wb-header">
        <Link className="wb-title" to="/login">
          <b>{t("app.name")}</b>
          <span>{t("admin.wallboard.title")}</span>
        </Link>
        <label className="wb-branch">
          <span className="qa-sr-only">{t("admin.branch")}</span>
          <select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branchLabel(branch.id)}</option>)}
            <option value="all">{t("admin.allBranches")}</option>
          </select>
        </label>
        <span className={`wb-pill is-${connection}`} role="status">
          <i aria-hidden="true" />
          {t(`admin.wallboard.conn.${connection}`)}
          {sinceEvent !== null ? <small>{t("admin.wallboard.lastEvent", { seconds: sinceEvent })}</small> : null}
        </span>
        <span className="wb-keys" aria-hidden="true"><kbd>F</kbd> {t("admin.wallboard.keyFullscreen")} <kbd>B</kbd> {t("admin.wallboard.keyBranch")}</span>
        <time className="wb-clock" dateTime={now.toISOString()}>
          <b className="mono">{now.toLocaleTimeString("en-GB")}</b>
          <small>{now.toLocaleDateString(i18n.language, { month: "long", day: "numeric", weekday: "long" })}</small>
        </time>
        <Link className="wb-exit" to="/admin">{t("admin.wallboard.exit")}</Link>
        <button type="button" className="wb-logout" onClick={() => void signOut()}>Log out / 退出</button>
      </header>

      <section className="wb-kpis" aria-label={t("admin.wallboard.kpis")}>
        <KpiCard label={t("admin.wallboard.kpi.activeLoans")} scope={scopeAll} value={kpis.activeLoans} history={history.activeLoans} />
        <KpiCard label={t("admin.wallboard.kpi.todayBorrowed")} scope={scopeBranch} value={kpis.todayBorrowed} history={history.todayBorrowed} tone="success" />
        <KpiCard label={t("admin.wallboard.kpi.openAlerts")} scope={scopeBranch} value={kpis.openAlerts} history={history.openAlerts} tone={hasCritical ? "critical" : openAlerts.length ? "warn" : "success"} />
        <KpiCard label={t("admin.wallboard.kpi.devicesOnline")} scope={scopeBranch} value={kpis.devicesOnline} suffix={deviceList.length ? ` / ${deviceList.length}` : ""} history={history.devicesOnline} tone={deviceList.length && online < deviceList.length ? "warn" : "success"} />
        <KpiCard label={t("admin.wallboard.kpi.occupancy")} scope={scopeBranch} value={kpis.occupancy} history={history.occupancy} />
        <KpiCard label={t("admin.wallboard.kpi.books")} scope={scopeAll} value={kpis.books} history={history.books} />
      </section>

      <section className="wb-panel wb-env-panel" aria-label={t("admin.wallboard.environment")}>
        <h2>{t("admin.wallboard.environment")}<small>{branchId === "all" ? t("admin.wallboard.envAll") : scopeBranch}</small></h2>
        <div className="wb-env-grid">
          {ENV_METRICS.map((metric) => <EnvTile key={metric} metric={metric} value={aggregate(metric, env[metric].byDevice)} history={env[metric].history} />)}
        </div>
      </section>

      <section className="wb-panel wb-chart-panel" aria-label={t("admin.wallboard.hourly")}>
        <h2>{t("admin.wallboard.hourly")}<small>{scopeBranch}</small></h2>
        <HourlyChart buckets={buckets} />
      </section>

      <section className={`wb-panel wb-alert-panel ${hasCritical ? "has-critical" : ""}`} aria-label={t("admin.wallboard.alerts")}>
        <h2>{t("admin.wallboard.alerts")}<small className="mono">{openAlerts.length} / {alerts.length}</small></h2>
        <AlertFeed alerts={alerts} fresh={freshAlerts} devices={devices} onAck={(alert) => void acknowledge(alert)} busyId={busyAlert} />
      </section>

      <section className="wb-panel wb-device-panel" aria-label={t("admin.wallboard.devices")}>
        <h2>{t("admin.wallboard.devices")}<small className="mono">{online} / {deviceList.length}</small></h2>
        <DeviceMatrix devices={deviceList} changed={deviceFlash} />
      </section>

      <section className="wb-panel wb-flow-panel" aria-label={t("admin.wallboard.flow")}>
        <h2>{t("admin.wallboard.flow")}<small>{t("admin.wallboard.flowHint")}</small></h2>
        <EventFlow ref={flowRef} counts={flowCounts} />
      </section>
    </div>
  );
}
