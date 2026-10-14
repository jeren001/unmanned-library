import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button, EmptyState, Skeleton, StatusBadge, useToast } from "../shared/components";
import { CountUp, StaggerList } from "../shared/motion";
import { fetchOpenAlerts, fetchOverview, fetchRules, listPage, saveRule, type AlertRow, type LoanRow, type Overview, type RuleRow } from "./adminApi";
import { useAdmin } from "./adminContext";
import { alertMessage } from "./alertText";
import { ErrorPanel, errorText, formatDate, PageHeading } from "./adminUi";
import { LookupName } from "./ListPages";

type Load<T> = { status: "loading" | "ready" | "error"; data?: T; error?: unknown };

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((previous) => ({ ...previous, status: previous.data === undefined ? "loading" : previous.status }));
    load().then((data) => { if (alive) setState({ status: "ready", data }); }).catch((error) => { if (alive) setState({ status: "error", error }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((value) => value + 1) };
}

/* ---------- Overview ---------- */

const KPIS: Array<{ key: keyof Overview; path?: string; tone?: "alert" }> = [
  { key: "books", path: "books" },
  { key: "activeLoans", path: "circulation" },
  { key: "readers", path: "readers" },
  { key: "openAlerts", tone: "alert" },
  { key: "devicesOnline" },
  { key: "branches" }
];

const SEVERITY_TONE = { info: "info", warning: "warn", critical: "danger" } as const;

export function OverviewPage({ branchId, refreshKey }: { branchId: string; refreshKey: number }) {
  const { t } = useTranslation();
  const { branchName } = useAdmin();
  const navigate = useNavigate();
  const overview = useLoad(fetchOverview, [refreshKey]);
  const alerts = useLoad(() => fetchOpenAlerts(branchId).then((rows) => rows.slice(0, 5)), [branchId, refreshKey]);
  const loans = useLoad(() => listPage<LoanRow>("/api/loans", { page: 1, pageSize: 6, branchId }).then((page) => page.rows), [branchId, refreshKey]);

  return (
    <>
      <PageHeading eyebrow="OPERATIONS / OVERVIEW" title={t("admin.overview.title")} subtitle={t("admin.overview.subtitle")} />
      {overview.status === "error" ? <ErrorPanel error={overview.error} onRetry={overview.reload} /> : (
        <StaggerList className="admin-kpis" step={70}>
          {KPIS.map((kpi) => {
            const body = (
              <>
                <span>{t(`admin.kpi.${kpi.key}`)}</span>
                <b>{overview.data ? <CountUp value={overview.data[kpi.key]} /> : <span className="admin-kpi-skeleton" aria-label={t("state.loading")} />}</b>
                <small>{t(`admin.kpi.${kpi.key}Hint`)}</small>
              </>
            );
            const className = `admin-kpi ${kpi.tone === "alert" && overview.data?.openAlerts ? "is-alert" : ""}`;
            return kpi.path
              ? <button key={kpi.key} type="button" className={className} onClick={() => navigate(`/admin/${kpi.path}`)}>{body}</button>
              : <div key={kpi.key} className={className}>{body}</div>;
          })}
        </StaggerList>
      )}
      {branchId !== "all" ? <p className="admin-note">{t("admin.overview.branchNote")}</p> : null}

      <div className="admin-panels">
        <section className="admin-panel">
          <h2>{t("admin.overview.alerts")}</h2>
          {alerts.status === "loading" ? <Skeleton lines={4} /> : alerts.status === "error" ? <ErrorPanel error={alerts.error} onRetry={alerts.reload} /> : alerts.data?.length ? (
            <StaggerList as="ul" className="admin-feed" replayKey={alerts.data?.map((alert) => alert.id).join()}>
              {alerts.data.map((alert: AlertRow) => (
                <li key={alert.id}>
                  <StatusBadge tone={SEVERITY_TONE[alert.severity] ?? "info"} label={t(`admin.severity.${alert.severity}`)} />
                  <span>{alertMessage(t, alert, branchName(alert.branch_id))}</span>
                  <time className="mono">{formatDate(alert.created_at)}</time>
                </li>
              ))}
            </StaggerList>
          ) : <EmptyState title={t("admin.overview.noAlerts")} body={t("admin.overview.noAlertsBody")} />}
        </section>
        <section className="admin-panel">
          <h2>{t("admin.overview.loans")}</h2>
          {loans.status === "loading" ? <Skeleton lines={4} /> : loans.status === "error" ? <ErrorPanel error={loans.error} onRetry={loans.reload} /> : loans.data?.length ? (
            <StaggerList as="ul" className="admin-feed" replayKey={loans.data?.map((loan) => loan.id).join()}>
              {loans.data.map((loan) => (
                <li key={loan.id}>
                  <StatusBadge status={loan.status === "overdue" ? "overdue" : loan.status === "returned" ? "in" : "borrowed"} label={t(`admin.loanStatus.${loan.status}`)} />
                  <span><LookupName kind="book" id={loan.book_id} /></span>
                  <time className="mono">{formatDate(loan.borrowed_at)}</time>
                </li>
              ))}
            </StaggerList>
          ) : <EmptyState title={t("admin.loans.emptyTitle")} body={t("admin.loans.emptyBody")} />}
          <Button variant="ghost" onClick={() => navigate("/admin/circulation")}>{t("admin.overview.allLoans")}</Button>
        </section>
      </div>
    </>
  );
}

/* ---------- Settings > Rules ---------- */

function parseValue(rule: RuleRow): unknown {
  try {
    return JSON.parse(rule.value_json);
  } catch {
    return rule.value_json;
  }
}

export function RulesPage() {
  const { t } = useTranslation();
  const rules = useLoad(fetchRules, []);

  return (
    <>
      <PageHeading eyebrow="SETTINGS / RULES" title={t("admin.rules.title")} subtitle={t("admin.rules.subtitle")} />
      {rules.status === "loading" ? <Skeleton lines={6} /> : rules.status === "error" ? <ErrorPanel error={rules.error} onRetry={rules.reload} /> : rules.data?.data.length ? (
        <>
          {rules.data.lastChanged?.ts ? <p className="admin-note">{t("admin.rules.lastChanged", { date: formatDate(rules.data.lastChanged.ts) })}</p> : null}
          <StaggerList className="admin-rules">
            {rules.data.data.map((rule) => <RuleEditor key={rule.key} rule={rule} />)}
          </StaggerList>
        </>
      ) : <EmptyState title={t("admin.rules.emptyTitle")} body={t("admin.rules.emptyBody")} />}
    </>
  );
}

function RuleEditor({ rule }: { rule: RuleRow }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const initial = parseValue(rule);
  const numeric = typeof initial === "number";
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(typeof initial === "string" ? initial : JSON.stringify(initial));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const label = i18n.exists(`admin.rules.key.${rule.key}`) ? t(`admin.rules.key.${rule.key}`) : rule.key;
  const dirty = draft !== (typeof saved === "string" ? saved : JSON.stringify(saved));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    let value: unknown = draft;
    if (numeric) {
      const number = Number(draft);
      if (!Number.isInteger(number) || number < 0) {
        setError(t("admin.rules.invalidNumber"));
        return;
      }
      value = number;
    } else if (typeof initial !== "string") {
      try {
        value = JSON.parse(draft);
      } catch {
        setError(t("admin.rules.invalidJson"));
        return;
      }
    }
    setSaving(true);
    try {
      await saveRule(rule.key, value, rule.description);
      setSaved(value);
      toast({ tone: "success", title: t("admin.rules.saved"), body: `${label} → ${draft}` });
    } catch (caught) {
      setError(errorText(t, caught));
    } finally {
      setSaving(false);
    }
  }

  const id = `rule-${rule.key}`;
  return (
    <form className="admin-rule" onSubmit={onSubmit} noValidate>
      <div>
        <label htmlFor={id}>{label}</label>
        <code>{rule.key}</code>
        <p>{rule.description}</p>
      </div>
      <div className="admin-rule-edit">
        <input
          id={id}
          className={numeric ? "mono" : undefined}
          inputMode={numeric ? "numeric" : undefined}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <Button type="submit" loading={saving} disabled={!dirty}>{t("admin.rules.save")}</Button>
      </div>
      {error ? <strong id={`${id}-error`} role="alert">{error}</strong> : null}
    </form>
  );
}
