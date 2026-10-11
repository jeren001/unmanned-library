import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Skeleton, StatusBadge, useToast } from "../shared/components";
import { fetchSimulator, runScenario, SCENARIOS, setSimulator, type Scenario, type SimulatorStatus } from "./adminApi";
import { useAdmin, useAdminEvent } from "./adminContext";
import { ErrorPanel, errorText, PageHeading } from "./adminUi";
import "./ops.css";

const DANGER: Scenario[] = ["smoke_spike", "illegal_exit", "network_outage"];

/** Admin-only control panel for the in-server device simulator. */
export function SimulatorPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { branches, branchId, branchName } = useAdmin();
  const [status, setStatus] = useState<{ state: "loading" | "ready" | "error"; data?: SimulatorStatus; error?: unknown }>({ state: "loading" });
  const [target, setTarget] = useState(branchId !== "all" ? branchId : "");
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ at: string; text: string; ok: boolean }>>([]);

  const refresh = useCallback(() => {
    fetchSimulator().then((data) => setStatus({ state: "ready", data })).catch((error) => setStatus({ state: "error", error }));
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!target && branches.length) setTarget(branches[0].id);
  }, [branches, target]);

  // Show what the scenarios cause, straight from the live stream.
  useAdminEvent<{ message?: string; name?: string; to?: string }>(["alert.raised", "device.status_changed"], (payload, name) => {
    const text = name === "alert.raised" ? `alert.raised · ${payload?.message ?? ""}` : `device.status_changed · ${payload?.name ?? ""} → ${payload?.to ?? ""}`;
    setLog((value) => [{ at: new Date().toISOString(), text, ok: true }, ...value].slice(0, 12));
  });

  async function toggle(enabled: boolean) {
    setBusy("toggle");
    try {
      setStatus({ state: "ready", data: await setSimulator(enabled) });
      toast({ tone: "info", title: enabled ? t("admin.sim.started") : t("admin.sim.stopped") });
    } catch (error) {
      toast({ tone: "alert", title: t("admin.error.title"), body: errorText(t, error) });
    } finally {
      setBusy(null);
    }
  }

  async function run(scenario: Scenario) {
    setBusy(scenario);
    try {
      const result = await runScenario(scenario, target || undefined);
      setLog((value) => [{ at: new Date().toISOString(), text: `${scenario} → ${branchName(result.branchId)} (${t("admin.sim.queued", { count: result.queued })})`, ok: true }, ...value].slice(0, 12));
      toast({ tone: "info", title: t(`admin.sim.scenario.${scenario}`), body: branchName(result.branchId) });
      refresh();
    } catch (error) {
      setLog((value) => [{ at: new Date().toISOString(), text: `${scenario} ✕ ${errorText(t, error)}`, ok: false }, ...value].slice(0, 12));
    } finally {
      setBusy(null);
    }
  }

  const data = status.data;
  const active = data ? Object.entries(data.scenarios).filter(([, value]) => value.until > Date.now()) : [];

  return (
    <>
      <PageHeading eyebrow="SETTINGS / SIMULATOR" title={t("admin.nav.simulator")} subtitle={t("admin.sim.subtitle")} />
      {status.state === "error" ? <ErrorPanel error={status.error} onRetry={refresh} /> : !data ? <Skeleton lines={5} /> : (
        <div className="admin-sim">
          <section className="admin-panel admin-sim-state">
            <h2>{t("admin.sim.engine")}</h2>
            <div className="admin-sim-row">
              <StatusBadge tone={data.running ? "ok" : "offline"} label={data.running ? t("admin.sim.running") : t("admin.sim.paused")} />
              <span className="mono">{t("admin.sim.queue", { count: data.queued })}</span>
            </div>
            <Button variant={data.enabled ? "ghost" : "primary"} loading={busy === "toggle"} onClick={() => void toggle(!data.enabled)}>
              {data.enabled ? t("admin.sim.stop") : t("admin.sim.start")}
            </Button>
            {active.length ? (
              <ul className="admin-sim-active">
                {active.map(([branch, value]) => <li key={branch}><b>{t(`admin.sim.scenario.${value.scenario}`, { defaultValue: value.scenario })}</b> · {branchName(branch)}</li>)}
              </ul>
            ) : <p className="admin-muted">{t("admin.sim.noneActive")}</p>}
          </section>

          <section className="admin-panel">
            <h2>{t("admin.sim.scenarios")}</h2>
            <label className="admin-sim-target">
              <span>{t("admin.sim.target")}</span>
              <select value={target} onChange={(event) => setTarget(event.target.value)}>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branchName(branch.id)}</option>)}
              </select>
            </label>
            <div className="admin-sim-buttons">
              {SCENARIOS.map((scenario) => (
                <button
                  key={scenario}
                  type="button"
                  className={`admin-sim-button ${DANGER.includes(scenario) ? "is-danger" : scenario === "recover" ? "is-recover" : ""}`}
                  disabled={busy !== null}
                  aria-busy={busy === scenario}
                  onClick={() => void run(scenario)}
                >
                  <b>{t(`admin.sim.scenario.${scenario}`)}</b>
                  <small>{t(`admin.sim.desc.${scenario}`)}</small>
                  <code>{scenario}</code>
                </button>
              ))}
            </div>
          </section>

          <section className="admin-panel admin-sim-log">
            <h2>{t("admin.sim.log")}</h2>
            <ol className="admin-test-log mono" aria-live="polite">
              {log.length ? log.map((entry, index) => (
                <li key={`${entry.at}-${index}`} className={entry.ok ? "is-ok" : "is-fail"}><span>{entry.at.slice(11, 19)}</span> {entry.text}</li>
              )) : <li className="admin-muted">{t("admin.sim.logEmpty")}</li>}
            </ol>
          </section>
        </div>
      )}
    </>
  );
}
