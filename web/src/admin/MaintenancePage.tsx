import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Button, Drawer, StatusBadge, useToast, type Column } from "../shared/components";
import {
  createMaintenance, fetchAlerts, fetchDeviceIndex, listPage,
  type AlertFull, type DeviceRow, type MaintenanceKind, type MaintenanceRow
} from "./adminApi";
import { useAdmin } from "./adminContext";
import { errorText, ListView, PageHeading, usePagedList } from "./adminUi";
import "./ops.css";

const KINDS: MaintenanceKind[] = ["device_repair", "inventory", "book_mending", "restock"];

function localNow() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function stamp(value?: string | null) {
  return value ? value.replace("T", " ").slice(0, 16) : "—";
}

export function MaintenancePage() {
  const { t } = useTranslation();
  const { branchId, branchName } = useAdmin();
  const list = usePagedList<MaintenanceRow>((page) => listPage("/api/maintenance", page), { branchId });
  const [devices, setDevices] = useState<Map<string, DeviceRow>>(new Map());
  const [selected, setSelected] = useState<MaintenanceRow | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void fetchDeviceIndex("all").then(setDevices).catch(() => setDevices(new Map()));
  }, []);

  const deviceName = (id?: string | null) => (id ? devices.get(id)?.name ?? id : "—");

  const columns: Column<MaintenanceRow>[] = [
    { key: "started_at", header: t("admin.maintenance.started"), mono: true, render: (row) => stamp(row.started_at) },
    { key: "kind", header: t("admin.maintenance.kind"), render: (row) => <span className={`admin-kind is-${row.kind}`}>{t(`admin.maintenance.kinds.${row.kind}`)}</span> },
    { key: "description", header: t("admin.maintenance.description"), render: (row) => <span className="admin-clamp">{row.description}</span> },
    { key: "branch", header: t("admin.branch"), render: (row) => branchName(row.branch_id) },
    { key: "device", header: t("admin.alertsPage.device"), render: (row) => deviceName(row.device_id) },
    { key: "alert", header: t("admin.maintenance.alert"), mono: true, render: (row) => row.related_alert_id ?? "—" },
    { key: "state", header: t("catalog.status"), render: (row) => row.finished_at ? <StatusBadge tone="ok" label={t("admin.maintenance.done")} /> : <StatusBadge tone="warn" label={t("admin.maintenance.inProgress")} /> }
  ];

  return (
    <>
      <PageHeading eyebrow="OPERATIONS / MAINTENANCE" title={t("admin.nav.maintenance")} subtitle={t("admin.maintenance.subtitle")} />
      <div className="admin-maintenance">
        <MaintenanceForm devices={devices} onCreated={list.reload} />
        <ListView
          list={list}
          columns={columns}
          rowKey={(row) => row.id}
          caption={t("admin.nav.maintenance")}
          selectedKey={open ? selected?.id : null}
          onRowClick={(row) => { setSelected(row); setOpen(true); }}
          emptyTitle={t("admin.maintenance.emptyTitle")}
          emptyBody={t("admin.maintenance.emptyBody")}
        />
      </div>
      <Drawer open={open} onClose={() => setOpen(false)} title={selected ? t(`admin.maintenance.kinds.${selected.kind}`) : ""}>
        {selected ? (
          <div className="admin-detail">
            <p className="admin-detail-text">{selected.description}</p>
            <dl className="admin-detail-extra admin-dl">
              <dt>{t("admin.branch")}</dt><dd>{branchName(selected.branch_id)}</dd>
              <dt>{t("admin.alertsPage.device")}</dt><dd>{deviceName(selected.device_id)}</dd>
              <dt>{t("admin.maintenance.alert")}</dt><dd className="mono">{selected.related_alert_id ?? "—"}</dd>
              <dt>{t("admin.maintenance.started")}</dt><dd className="mono">{stamp(selected.started_at)}</dd>
              <dt>{t("admin.maintenance.finished")}</dt><dd className="mono">{stamp(selected.finished_at)}</dd>
              <dt>{t("admin.maintenance.operator")}</dt><dd className="mono">{selected.operator_id ?? "—"}</dd>
            </dl>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}

type Errors = Partial<Record<"branch" | "description" | "started" | "finished" | "form", string>>;

function MaintenanceForm({ devices, onCreated }: { devices: Map<string, DeviceRow>; onCreated: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { user, branches, branchId: currentBranch, branchName } = useAdmin();
  const [params, setParams] = useSearchParams();
  const [branch, setBranch] = useState(params.get("branchId") ?? (currentBranch !== "all" ? currentBranch : ""));
  const [device, setDevice] = useState(params.get("deviceId") ?? "");
  const [alert, setAlert] = useState(params.get("alertId") ?? "");
  const [kind, setKind] = useState<MaintenanceKind>(params.get("deviceId") || params.get("alertId") ? "device_repair" : "inventory");
  const [description, setDescription] = useState("");
  const [started, setStarted] = useState(localNow);
  const [finished, setFinished] = useState("");
  const [alerts, setAlerts] = useState<AlertFull[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);

  // Open and acknowledged alerts of the chosen branch can be linked.
  useEffect(() => {
    if (!branch) { setAlerts([]); return; }
    let alive = true;
    void Promise.all([fetchAlerts("open", branch), fetchAlerts("acked", branch)])
      .then(([openRows, ackedRows]) => { if (alive) setAlerts([...openRows, ...ackedRows]); })
      .catch(() => { if (alive) setAlerts([]); });
    return () => { alive = false; };
  }, [branch]);

  const branchDevices = [...devices.values()].filter((item) => item.branch_id === branch);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next: Errors = {};
    if (!branch) next.branch = t("admin.maintenance.err.branch");
    if (description.trim().length < 4) next.description = t("admin.maintenance.err.description");
    if (!started) next.started = t("admin.maintenance.err.started");
    if (finished && started && finished < started) next.finished = t("admin.maintenance.err.finished");
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      await createMaintenance({
        branch_id: branch,
        device_id: device || null,
        kind,
        description: description.trim(),
        started_at: new Date(started).toISOString(),
        finished_at: finished ? new Date(finished).toISOString() : null,
        operator_id: user.id,
        related_alert_id: alert || null
      });
      toast({ tone: "success", title: t("admin.maintenance.created"), body: description.trim() });
      setDescription("");
      setFinished("");
      setStarted(localNow());
      if (params.toString()) setParams({}, { replace: true });
      onCreated();
    } catch (error) {
      setErrors({ form: errorText(t, error) });
    } finally {
      setSaving(false);
    }
  }

  const field = (id: string, error?: string) => ({ id, "aria-invalid": Boolean(error), "aria-describedby": error ? `${id}-error` : undefined });
  const fieldError = (id: string, error?: string) => (error ? <strong id={`${id}-error`} role="alert">{error}</strong> : null);

  return (
    <form className="admin-form" onSubmit={onSubmit} noValidate aria-labelledby="maintenance-form-title">
      <h2 id="maintenance-form-title">{t("admin.maintenance.new")}</h2>
      {alert ? <p className="admin-form-linked">{t("admin.maintenance.linkedTo", { id: alert })}</p> : null}

      <label htmlFor="m-branch">{t("admin.branch")} *</label>
      <select {...field("m-branch", errors.branch)} value={branch} onChange={(event) => { setBranch(event.target.value); setDevice(""); setAlert(""); }}>
        <option value="">{t("admin.maintenance.choose")}</option>
        {branches.map((item) => <option key={item.id} value={item.id}>{branchName(item.id)}</option>)}
      </select>
      {fieldError("m-branch", errors.branch)}

      <label htmlFor="m-kind">{t("admin.maintenance.kind")} *</label>
      <select id="m-kind" value={kind} onChange={(event) => setKind(event.target.value as MaintenanceKind)}>
        {KINDS.map((item) => <option key={item} value={item}>{t(`admin.maintenance.kinds.${item}`)}</option>)}
      </select>

      <label htmlFor="m-device">{t("admin.alertsPage.device")}</label>
      <select id="m-device" value={device} disabled={!branch} onChange={(event) => setDevice(event.target.value)}>
        <option value="">{t("admin.maintenance.none")}</option>
        {branchDevices.map((item) => <option key={item.id} value={item.id}>{item.name} · {t(`admin.deviceStatus.${item.status}`)}</option>)}
        {device && !branchDevices.some((item) => item.id === device) ? <option value={device}>{device}</option> : null}
      </select>

      <label htmlFor="m-alert">{t("admin.maintenance.alert")}</label>
      <select id="m-alert" value={alert} disabled={!branch} onChange={(event) => setAlert(event.target.value)}>
        <option value="">{t("admin.maintenance.none")}</option>
        {alerts.map((item) => <option key={item.id} value={item.id}>[{t(`admin.severity.${item.severity}`)}] {item.message.slice(0, 40)}</option>)}
        {alert && !alerts.some((item) => item.id === alert) ? <option value={alert}>{alert}</option> : null}
      </select>

      <label htmlFor="m-description">{t("admin.maintenance.description")} *</label>
      <textarea {...field("m-description", errors.description)} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
      {fieldError("m-description", errors.description)}

      <div className="admin-form-pair">
        <div>
          <label htmlFor="m-started">{t("admin.maintenance.started")} *</label>
          <input {...field("m-started", errors.started)} type="datetime-local" value={started} onChange={(event) => setStarted(event.target.value)} />
          {fieldError("m-started", errors.started)}
        </div>
        <div>
          <label htmlFor="m-finished">{t("admin.maintenance.finished")}</label>
          <input {...field("m-finished", errors.finished)} type="datetime-local" value={finished} onChange={(event) => setFinished(event.target.value)} />
          {fieldError("m-finished", errors.finished)}
        </div>
      </div>

      {errors.form ? <p className="admin-form-error" role="alert">{errors.form}</p> : null}
      <Button type="submit" loading={saving}>{t("admin.maintenance.submit")}</Button>
    </form>
  );
}
