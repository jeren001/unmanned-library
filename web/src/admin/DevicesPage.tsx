import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, CatalogCard, Drawer, EmptyState, Skeleton, StatusBadge } from "../shared/components";
import { animate, StaggerList } from "../shared/motion";
import { DEVICE_COMMANDS, listPage, testDevice, updateDevice, type DeviceRow, type DeviceStatus, type DeviceTestResult } from "./adminApi";
import { useAdmin, useAdminEvent } from "./adminContext";
import { deviceLabel } from "./alertText";
import { ErrorPanel, errorText, FilterChips, PageHeading, Pager, RelativeTime, SearchBox, useDebounced, usePagedList } from "./adminUi";
import "./ops.css";

const PAGE = 24;
const STATUS_TONE = { online: "ok", offline: "offline", fault: "danger" } as const;

export function DeviceBadge({ status }: { status: DeviceStatus }) {
  const { t } = useTranslation();
  return <StatusBadge tone={STATUS_TONE[status]} label={t(`admin.deviceStatus.${status}`)} />;
}

type Filter = "all" | DeviceStatus;

export function DevicesPage() {
  const { t } = useTranslation();
  const { branchId, branchName } = useAdmin();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Filter>("all");
  const q = useDebounced(query.trim());
  const list = usePagedList<DeviceRow>((page) => listPage("/api/devices", { ...page, pageSize: PAGE }), { q, status, branchId });
  // Live status changes patch cards in place until the next reload.
  const [live, setLive] = useState<Record<string, { status: DeviceStatus; at: string }>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [edited, setEdited] = useState<Record<string, DeviceRow>>({});

  useAdminEvent<{ deviceId?: string; to?: DeviceStatus; ts?: string }>(["device.status_changed"], (payload) => {
    if (payload?.deviceId && payload.to) setLive((value) => ({ ...value, [payload.deviceId!]: { status: payload.to!, at: payload.ts ?? new Date().toISOString() } }));
  });

  const devices = list.rows.map((device) => {
    const merged = edited[device.id] ?? device;
    const update = live[device.id];
    return update ? { ...merged, status: update.status, last_seen_at: update.status === "online" ? update.at : merged.last_seen_at } : merged;
  });
  const selected = devices.find((device) => device.id === selectedId) ?? null;
  const filtered = Boolean(q) || status !== "all";

  return (
    <>
      <PageHeading eyebrow="OPERATIONS / DEVICES" title={t("admin.nav.devices")} subtitle={t("admin.devices.subtitle")} />
      <div className="admin-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder={t("admin.devices.search")} />
        <FilterChips
          label={t("admin.filter")}
          value={status}
          onChange={setStatus}
          options={(["all", "online", "offline", "fault"] as const).map((value) => ({ value, label: value === "all" ? t("admin.all") : t(`admin.deviceStatus.${value}`) }))}
        />
      </div>

      {list.status === "error" ? <ErrorPanel error={list.error} onRetry={list.reload} /> : list.status === "loading" && !list.rows.length ? (
        <div className="admin-device-grid" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div key={index} className="admin-device-card is-skeleton"><Skeleton lines={4} /></div>)}</div>
      ) : !devices.length && list.page === 1 ? (
        <div className="admin-empty">
          <EmptyState
            title={filtered ? t("admin.empty.filteredTitle") : t("admin.devices.emptyTitle")}
            body={filtered ? t("admin.empty.filteredBody") : t("admin.devices.emptyBody")}
            action={filtered ? <Button variant="ghost" onClick={() => { setQuery(""); setStatus("all"); }}>{t("admin.empty.clear")}</Button> : undefined}
          />
        </div>
      ) : (
        <>
          <StaggerList className="admin-device-grid" replayKey={list.rows.map((device) => device.id).join()} step={40}>
            {devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                branch={branchName(device.branch_id)}
                changedAt={live[device.id]?.at}
                selected={open && selectedId === device.id}
                onOpen={() => { setSelectedId(device.id); setOpen(true); }}
              />
            ))}
          </StaggerList>
          <Pager page={list.page} hasNext={list.hasNext} onPage={list.setPage} disabled={list.status === "loading"} />
        </>
      )}

      <Drawer open={open} onClose={() => setOpen(false)} title={selected ? <span title={selected.name}>{deviceLabel(t, selected)}</span> : ""}>
        {selected ? <DeviceDetail key={selected.id} device={selected} branch={branchName(selected.branch_id)} onSaved={(device) => setEdited((value) => ({ ...value, [device.id]: device }))} /> : null}
      </Drawer>
    </>
  );
}

function DeviceCard({ device, branch, changedAt, selected, onOpen }: { device: DeviceRow; branch: string; changedAt?: string; selected: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);

  // Flash the card when its status changes live.
  useLayoutEffect(() => {
    if (!changedAt) return;
    const animation = animate(ref.current, [{ boxShadow: "0 0 0 0 rgba(214, 56, 79, .45)" }, { boxShadow: "0 0 0 10px rgba(214, 56, 79, 0)" }], { duration: 900, easing: "ease-out" });
    return () => animation?.cancel();
  }, [changedAt]);

  return (
    <button ref={ref} type="button" className={`admin-device-card is-${device.status} ${selected ? "is-selected" : ""}`} onClick={onOpen} aria-label={`${deviceLabel(t, device)} · ${t(`admin.deviceStatus.${device.status}`)}`} title={device.name}>
      <span className="admin-device-spine" aria-hidden="true" />
      <span className="admin-device-head">
        <code>{t(`admin.deviceKind.${device.kind}`, { defaultValue: device.kind })}</code>
        <DeviceBadge status={device.status} />
      </span>
      <b>{deviceLabel(t, device)}</b>
      <span className="admin-device-meta">{branch} · {device.vendor}</span>
      <span className="admin-device-foot">
        <span className="mono">{device.protocol}://{device.address}</span>
        <span>{t("admin.devices.lastSeen")} <RelativeTime value={device.last_seen_at} /></span>
      </span>
    </button>
  );
}

function prettyConfig(json: string) {
  try {
    return JSON.stringify(JSON.parse(json || "{}"), null, 2);
  } catch {
    return json;
  }
}

function DeviceDetail({ device, branch, onSaved }: { device: DeviceRow; branch: string; onSaved: (device: DeviceRow) => void }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState(() => prettyConfig(device.config_json));
  const [saved, setSaved] = useState(config);
  const [configError, setConfigError] = useState("");
  const [saving, setSaving] = useState(false);
  const commands = DEVICE_COMMANDS[device.kind] ?? DEVICE_COMMANDS.default;
  const [command, setCommand] = useState(commands[0]);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<DeviceTestResult[]>([]);

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    setConfigError("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(config);
    } catch {
      setConfigError(t("admin.devices.configInvalid"));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setConfigError(t("admin.devices.configObject"));
      return;
    }
    setSaving(true);
    try {
      const updated = await updateDevice(device.id, { config_json: JSON.stringify(parsed) });
      const pretty = prettyConfig(updated.config_json ?? JSON.stringify(parsed));
      setConfig(pretty);
      setSaved(pretty);
      onSaved({ ...device, ...updated });
    } catch (error) {
      setConfigError(errorText(t, error));
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setRunning(true);
    try {
      const result = await testDevice(device, command);
      setLog((value) => [result, ...value].slice(0, 8));
    } catch (error) {
      setLog((value) => [{ command, ok: false, latencyMs: null, output: errorText(t, error), at: new Date().toISOString() }, ...value].slice(0, 8));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="admin-detail">
      <CatalogCard callNumber={device.id} callNumberLabel="ID" title={deviceLabel(t, device)} author={device.vendor} location={branch}>
        <dl className="admin-detail-extra">
          <dt>{t("admin.devices.kind")}</dt><dd>{t(`admin.deviceKind.${device.kind}`, { defaultValue: device.kind })}</dd>
          <dt>{t("admin.devices.address")}</dt><dd className="mono">{device.protocol}://{device.address}</dd>
          <dt>{t("admin.devices.lastSeen")}</dt><dd><RelativeTime value={device.last_seen_at} /></dd>
          <dt>{t("catalog.status")}</dt><dd><DeviceBadge status={device.status} /></dd>
        </dl>
      </CatalogCard>

      <form className="admin-config" onSubmit={saveConfig} noValidate>
        <label htmlFor={`config-${device.id}`}>{t("admin.devices.config")}</label>
        <textarea
          id={`config-${device.id}`}
          className="mono"
          rows={8}
          spellCheck={false}
          value={config}
          onChange={(event) => setConfig(event.target.value)}
          aria-invalid={Boolean(configError)}
          aria-describedby={configError ? `config-${device.id}-error` : undefined}
        />
        {configError ? <strong id={`config-${device.id}-error`} role="alert">{configError}</strong> : null}
        <div className="admin-config-actions">
          <Button type="button" variant="ghost" disabled={config === saved || saving} onClick={() => { setConfig(saved); setConfigError(""); }}>{t("admin.devices.reset")}</Button>
          <Button type="submit" loading={saving} disabled={config === saved}>{t("admin.devices.saveConfig")}</Button>
        </div>
      </form>

      <section className="admin-test">
        <h4>{t("admin.devices.test")}</h4>
        <div className="admin-test-row">
          <label className="qa-sr-only" htmlFor={`command-${device.id}`}>{t("admin.devices.command")}</label>
          <select id={`command-${device.id}`} value={command} onChange={(event) => setCommand(event.target.value)}>
            {commands.map((item) => <option key={item} value={item}>{t(`admin.devices.cmd.${item}`, { defaultValue: item })}</option>)}
          </select>
          <Button type="button" loading={running} onClick={() => void runTest()}>{t("admin.devices.run")}</Button>
        </div>
        <ol className="admin-test-log mono" aria-live="polite">
          {log.length ? log.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className={entry.ok ? "is-ok" : "is-fail"}>
              <span>{entry.at.slice(11, 19)}</span> {entry.ok ? "✓" : "✕"} {entry.output}{entry.simulated ? ` · ${t("admin.simulated")}` : ""}
            </li>
          )) : <li className="admin-muted">{t("admin.devices.logEmpty")}</li>}
        </ol>
      </section>
    </div>
  );
}
