import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button, Drawer, EmptyState, Skeleton, StatusBadge, Tabs, Timeline, useToast } from "../shared/components";
import { animate, easing, StaggerList } from "../shared/motion";
import {
  ackAlert, alertTimeline, fetchAlerts, fetchClip, fetchDeviceIndex, fetchMaintenanceForAlert, resolveAlert, sortAlerts,
  type AlertFull, type AlertStatus, type ClipRow, type DeviceRow, type MaintenanceRow
} from "./adminApi";
import { useAdmin, useAdminEvent } from "./adminContext";
import { ErrorPanel, errorText, formatDate, PageHeading, RelativeTime } from "./adminUi";
import "./ops.css";

const STATUSES: AlertStatus[] = ["open", "acked", "resolved"];
const SEVERITIES = ["critical", "warning", "info"] as const;
const SEVERITY_TONE = { critical: "danger", warning: "warn", info: "info" } as const;

type Board = Record<AlertStatus, AlertFull[] | undefined>;

export function AlertsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { branchId, branchName } = useAdmin();
  const [tab, setTab] = useState<AlertStatus>("open");
  const [board, setBoard] = useState<Board>({ open: undefined, acked: undefined, resolved: undefined });
  const [error, setError] = useState<unknown>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [devices, setDevices] = useState<Map<string, DeviceRow>>(new Map());
  const [selected, setSelected] = useState<AlertFull | null>(null);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);

  const load = useCallback(async (markNew: boolean) => {
    try {
      const [openRows, ackedRows, resolvedRows] = await Promise.all(STATUSES.map((status) => fetchAlerts(status, branchId)));
      setError(null);
      setBoard({ open: openRows, acked: ackedRows, resolved: resolvedRows });
      const ids = new Set(openRows.map((alert) => alert.id));
      if (markNew && known.current) {
        const added = [...ids].filter((id) => !known.current!.has(id));
        if (added.length) setFresh(new Set(added));
      }
      known.current = new Set([...(known.current ?? []), ...ids]);
    } catch (caught) {
      setError(caught);
    }
  }, [branchId]);

  useEffect(() => {
    known.current = null;
    setBoard({ open: undefined, acked: undefined, resolved: undefined });
    void load(false);
    void fetchDeviceIndex(branchId).then(setDevices).catch(() => setDevices(new Map()));
  }, [branchId, load]);

  // Live: new alerts slide into the Open board (the shell rings the bell and shows the toast).
  useAdminEvent(["alert.raised", "alert.acked", "alert.resolved"], (_payload, name) => void load(name === "alert.raised"));

  async function act(alert: AlertFull, action: "ack" | "resolve") {
    setBusyId(alert.id);
    try {
      const updated = action === "ack" ? await ackAlert(alert.id) : await resolveAlert(alert.id);
      toast({ tone: "success", title: t(action === "ack" ? "admin.alertsPage.acked" : "admin.alertsPage.resolved"), body: alert.message });
      if (selected?.id === alert.id) setSelected({ ...alert, ...updated });
      await load(false);
    } catch (caught) {
      toast({ tone: "alert", title: t("admin.error.title"), body: errorText(t, caught) });
    } finally {
      setBusyId(null);
    }
  }

  const rows = board[tab];
  const sorted = rows ? sortAlerts(rows) : [];

  return (
    <>
      <PageHeading eyebrow="OPERATIONS / ALERTS" title={t("admin.nav.alerts")} subtitle={t("admin.alertsPage.subtitle")} />
      <div className="admin-folder">
        <Tabs
          idPrefix="alerts"
          label={t("admin.alertsPage.tabs")}
          value={tab}
          onChange={(value) => setTab(value as AlertStatus)}
          items={STATUSES.map((status) => ({
            value: status,
            label: <>{t(`admin.alertStatus.${status}`)} <span className="admin-tab-count mono">{board[status]?.length ?? "·"}</span></>
          }))}
        />
        <section className="admin-folder-panel" role="tabpanel" id={`alerts-panel-${tab}`} aria-labelledby={`alerts-tab-${tab}`}>
          {error ? <ErrorPanel error={error} onRetry={() => void load(false)} /> : !rows ? (
            <div className="admin-alert-board">{SEVERITIES.map((severity) => <div key={severity} className="admin-alert-lane"><Skeleton lines={4} /></div>)}</div>
          ) : !sorted.length ? (
            <EmptyState title={t(`admin.alertsPage.empty.${tab}`)} body={t(`admin.alertsPage.emptyBody.${tab}`)} />
          ) : (
            <div className="admin-alert-board">
              {SEVERITIES.map((severity) => {
                const lane = sorted.filter((alert) => alert.severity === severity);
                return (
                  <section key={severity} className={`admin-alert-lane is-${severity}`} aria-label={t(`admin.severity.${severity}`)}>
                    <h2><StatusBadge tone={SEVERITY_TONE[severity]} label={t(`admin.severity.${severity}`)} /><span className="mono">{lane.length}</span></h2>
                    <StaggerList className="admin-alert-cards" replayKey={tab}>
                      {lane.map((alert) => (
                        <AlertCard
                          key={alert.id}
                          alert={alert}
                          fresh={fresh.has(alert.id)}
                          device={alert.device_id ? devices.get(alert.device_id) : undefined}
                          branch={branchName(alert.branch_id)}
                          busy={busyId === alert.id}
                          onOpen={() => { setSelected(alert); setOpen(true); }}
                          onAct={(action) => void act(alert, action)}
                        />
                      ))}
                      {!lane.length ? <p className="admin-lane-empty">{t("admin.alertsPage.laneEmpty")}</p> : null}
                    </StaggerList>
                  </section>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <Drawer open={open} onClose={() => setOpen(false)} title={selected ? t(`admin.alertType.${selected.type}`, { defaultValue: selected.type }) : ""}>
        {selected ? (
          <AlertDetail
            key={selected.id}
            alert={selected}
            device={selected.device_id ? devices.get(selected.device_id) : undefined}
            branch={branchName(selected.branch_id)}
            busy={busyId === selected.id}
            onAct={(action) => void act(selected, action)}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function AlertCard({ alert, fresh, device, branch, busy, onOpen, onAct }: {
  alert: AlertFull;
  fresh: boolean;
  device?: DeviceRow;
  branch: string;
  busy: boolean;
  onOpen: () => void;
  onAct: (action: "ack" | "resolve") => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (!fresh) return;
    const animation = animate(ref.current, [
      { opacity: 0, transform: "translateX(-28px)", boxShadow: "0 0 0 0 rgba(214, 56, 79, .5)" },
      { opacity: 1, transform: "none", boxShadow: "0 0 0 8px rgba(214, 56, 79, 0)" }
    ], { duration: 650, easing: easing.spring });
    return () => animation?.cancel();
  }, [fresh]);

  return (
    <article ref={ref} className={`admin-alert-card is-${alert.severity} ${fresh ? "is-fresh" : ""}`}>
      <span className="admin-alert-spine" aria-hidden="true" />
      <button type="button" className="admin-alert-open" onClick={onOpen}>
        <span className="admin-alert-head">
          <b>{t(`admin.alertType.${alert.type}`, { defaultValue: alert.type })}</b>
          <RelativeTime value={alert.created_at} />
        </span>
        <span className="admin-alert-message">{alert.message}</span>
        <span className="admin-alert-meta">{branch}{device ? ` · ${device.name}` : ""}{alert.related_clip_id ? ` · ${t("admin.alertsPage.hasClip")}` : ""}</span>
      </button>
      {alert.status !== "resolved" ? (
        <div className="admin-alert-actions">
          {alert.status === "open" ? <Button variant="ghost" disabled={busy} onClick={() => onAct("ack")}>{t("admin.alertsPage.ack")}</Button> : null}
          <Button variant={alert.status === "open" ? "ghost" : "primary"} loading={busy} onClick={() => onAct("resolve")}>{t("admin.alertsPage.resolve")}</Button>
        </div>
      ) : null}
    </article>
  );
}

function AlertDetail({ alert, device, branch, busy, onAct }: { alert: AlertFull; device?: DeviceRow; branch: string; busy: boolean; onAct: (action: "ack" | "resolve") => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [records, setRecords] = useState<{ status: "loading" | "ready" | "error"; rows: MaintenanceRow[]; error?: unknown }>({ status: "loading", rows: [] });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setRecords({ status: "loading", rows: [] });
    fetchMaintenanceForAlert(alert)
      .then((rows) => { if (alive) setRecords({ status: "ready", rows }); })
      .catch((error) => { if (alive) setRecords({ status: "error", rows: [], error }); });
    return () => { alive = false; };
  }, [alert, nonce]);

  const items = alertTimeline(alert, records.rows).map((event, index) => ({
    id: `${event.kind}-${index}`,
    at: event.at,
    title: `${t(`admin.alertsPage.event.${event.kind}`)}${event.approximate ? ` (${t("admin.alertsPage.approx")})` : ""}`,
    detail: event.detail,
    tone: event.kind === "resolved" ? "success" as const : event.kind === "raised" ? "danger" as const : "accent" as const
  }));

  const maintenanceLink = `/admin/maintenance?${new URLSearchParams({ alertId: alert.id, branchId: alert.branch_id, ...(alert.device_id ? { deviceId: alert.device_id } : {}) }).toString()}`;

  return (
    <div className="admin-detail">
      <div className={`admin-alert-summary is-${alert.severity}`}>
        <StatusBadge tone={SEVERITY_TONE[alert.severity]} label={t(`admin.severity.${alert.severity}`)} />
        <p>{alert.message}</p>
        <dl className="admin-detail-extra">
          <dt>{t("admin.branch")}</dt><dd>{branch}</dd>
          <dt>{t("admin.alertsPage.device")}</dt><dd>{device ? device.name : alert.device_id ?? "—"}</dd>
          <dt>{t("admin.alertsPage.raised")}</dt><dd className="mono">{alert.created_at.replace("T", " ").slice(0, 16)}</dd>
          <dt>{t("catalog.status")}</dt><dd>{t(`admin.alertStatus.${alert.status}`)}</dd>
          <dt>ID</dt><dd className="mono">{alert.id}</dd>
        </dl>
      </div>

      {alert.related_clip_id ? <ClipPlayer alert={alert} device={device} /> : null}

      <div className="admin-config-actions">
        {alert.status === "open" ? <Button variant="ghost" disabled={busy} onClick={() => onAct("ack")}>{t("admin.alertsPage.ack")}</Button> : null}
        {alert.status !== "resolved" ? <Button loading={busy} onClick={() => onAct("resolve")}>{t("admin.alertsPage.resolve")}</Button> : null}
        <Button variant="ghost" onClick={() => navigate(maintenanceLink)}>{t("admin.alertsPage.logMaintenance")}</Button>
      </div>

      <section className="admin-history">
        <h4>{t("admin.alertsPage.timeline")}</h4>
        {records.status === "loading" ? <Skeleton lines={3} /> : records.status === "error"
          ? <ErrorPanel error={records.error} onRetry={() => setNonce((value) => value + 1)} />
          : <Timeline items={items} />}
      </section>
    </div>
  );
}

/**
 * Camera clip player. Plays the real recording when the API gives a URL; otherwise shows a
 * clearly labelled simulated feed for the clip's time window, with the same controls.
 */
export function ClipPlayer({ alert, device }: { alert: AlertFull; device?: DeviceRow }) {
  const { t } = useTranslation();
  const [clip, setClip] = useState<{ status: "loading" | "ready" | "error"; data?: ClipRow; error?: unknown }>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let alive = true;
    setClip({ status: "loading" });
    fetchClip(alert).then((data) => { if (alive) setClip({ status: "ready", data }); }).catch((error) => { if (alive) setClip({ status: "error", error }); });
    return () => { alive = false; };
  }, [alert, nonce]);

  const duration = clip.data ? Math.max(1, (new Date(clip.data.end_ts).getTime() - new Date(clip.data.start_ts).getTime()) / 1000) : 30;

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = (now - last) / 1000;
      last = now;
      setProgress((value) => {
        const next = value + delta / duration;
        if (next >= 1) {
          setPlaying(false);
          return 1;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration]);

  if (clip.status === "loading") return <div className="admin-clip"><Skeleton lines={4} /></div>;
  if (clip.status === "error") return <ErrorPanel error={clip.error} onRetry={() => setNonce((value) => value + 1)} />;
  const data = clip.data!;

  if (data.url) {
    return (
      <figure className="admin-clip">
        <video controls preload="metadata" src={data.url} aria-label={t("admin.clip.label", { device: device?.name ?? data.device_id ?? "" })} />
        <figcaption className="mono">{formatDate(data.start_ts)} {data.start_ts.slice(11, 19)} – {data.end_ts.slice(11, 19)}</figcaption>
      </figure>
    );
  }

  const stamp = new Date(new Date(data.start_ts).getTime() + progress * duration * 1000).toISOString();
  const alertAt = (new Date(alert.created_at).getTime() - new Date(data.start_ts).getTime()) / 1000 / duration;

  return (
    <figure className="admin-clip">
      <div className="admin-clip-screen" role="img" aria-label={t("admin.clip.simulatedLabel", { device: device?.name ?? data.device_id ?? "" })}>
        <svg viewBox="0 0 320 180" preserveAspectRatio="none" aria-hidden="true">
          <rect width="320" height="180" fill="#120A0B" />
          {Array.from({ length: 5 }, (_, index) => <rect key={index} x={20 + index * 60} y="40" width="40" height="110" fill="#2A1A1C" />)}
          <rect x="0" y="150" width="320" height="30" fill="#1D1113" />
          <g transform={`translate(${30 + progress * 240} 0)`}>
            <circle cx="0" cy="98" r="9" fill="#5C4A4C" />
            <rect x="-9" y="108" width="18" height="38" rx="6" fill="#5C4A4C" />
          </g>
          {Math.abs(progress - alertAt) < 0.08 ? <rect x="2" y="2" width="316" height="176" fill="none" stroke="#D6384F" strokeWidth="4" /> : null}
        </svg>
        <span className="admin-clip-rec"><i />REC · {device?.name ?? data.device_id ?? "CAM"}</span>
        <span className="admin-clip-time mono">{stamp.replace("T", " ").slice(0, 19)}</span>
        <span className="admin-clip-sim">{t("admin.clip.simulated")}</span>
      </div>
      <div className="admin-clip-controls">
        <button
          type="button"
          onClick={() => {
            if (progress >= 1) setProgress(0);
            setPlaying((value) => !value);
          }}
          aria-label={playing ? t("admin.clip.pause") : t("admin.clip.play")}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          onChange={(event) => { setPlaying(false); setProgress(Number(event.target.value) / 1000); }}
          aria-label={t("admin.clip.seek")}
          aria-valuetext={stamp.slice(11, 19)}
          style={{ ["--alert-at" as string]: `${Math.min(100, Math.max(0, alertAt * 100))}%` }}
        />
        <span className="mono">{Math.round(progress * duration)}s / {Math.round(duration)}s</span>
      </div>
      <figcaption>{t("admin.clip.hint")}</figcaption>
    </figure>
  );
}
