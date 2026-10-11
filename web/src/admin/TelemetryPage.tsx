import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Button, EmptyState, Skeleton, StatusBadge } from "../shared/components";
import { fetchRules } from "./adminApi";
import { useAdmin } from "./adminContext";
import { ErrorPanel, FilterChips, PageHeading } from "./adminUi";
import {
  fetchTelemetrySeries, METRICS, parseThresholds, RANGES,
  type MetricKey, type RangeKey, type TelemetrySeries, type Threshold
} from "./insightApi";
import { TelemetryChart } from "./TelemetryChart";
import "./insight.css";

const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

/** Buckets whose min/max cross a threshold. */
export function breaches(series: TelemetrySeries, threshold?: Threshold) {
  if (!threshold) return 0;
  return series.buckets.filter((bucket) =>
    (threshold.max !== undefined && bucket.max !== null && bucket.max > threshold.max) ||
    (threshold.min !== undefined && bucket.min !== null && bucket.min < threshold.min)
  ).length;
}

export function TelemetryPage() {
  const { t } = useTranslation();
  const { branches, branchId: shellBranch, branchName } = useAdmin();
  const [params, setParams] = useSearchParams();
  const metric = (METRICS.some((item) => item.key === params.get("metric")) ? params.get("metric") : "temperature") as MetricKey;
  const range = (RANGE_KEYS.includes(params.get("range") as RangeKey) ? params.get("range") : "24h") as RangeKey;
  const branch = params.get("branch") ?? (shellBranch !== "all" ? shellBranch : branches[0]?.id ?? "");
  const [thresholds, setThresholds] = useState<Record<string, Threshold>>({});
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "error"; series?: TelemetrySeries; error?: unknown; at?: number }>({ status: "idle" });
  const [nonce, setNonce] = useState(0);

  const set = (key: string, value: string) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set(key, value);
    return next;
  }, { replace: true });

  // The top-bar branch drives the page unless a branch was picked here.
  useEffect(() => {
    if (shellBranch !== "all" && params.get("branch") && params.get("branch") !== shellBranch) set("branch", shellBranch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellBranch]);

  useEffect(() => {
    void fetchRules().then((body) => setThresholds(parseThresholds(body.data))).catch(() => setThresholds({}));
  }, []);

  useEffect(() => {
    if (!branch) return;
    let alive = true;
    setState((previous) => ({ ...previous, status: "loading" }));
    fetchTelemetrySeries(branch, metric, range)
      .then((series) => { if (alive) setState({ status: "ready", series, at: Date.now() }); })
      .catch((error) => { if (alive) setState({ status: "error", error }); });
    return () => { alive = false; };
  }, [branch, metric, range, nonce]);

  // The last 24 hours keep moving while the simulator runs.
  useEffect(() => {
    if (range !== "24h") return;
    const timer = window.setInterval(() => setNonce((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [range]);

  const spec = METRICS.find((item) => item.key === metric)!;
  const threshold = thresholds[metric];
  const series = state.series;
  const fmt = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${value.toFixed(spec.digits)}${spec.unit ? ` ${spec.unit}` : ""}`);

  const summary = useMemo(() => {
    if (!series) return null;
    const filled = series.buckets.filter((bucket) => bucket.count);
    const last = filled[filled.length - 1];
    return {
      latest: last?.avg ?? null,
      min: filled.length ? Math.min(...filled.map((bucket) => bucket.min!)) : null,
      max: filled.length ? Math.max(...filled.map((bucket) => bucket.max!)) : null,
      dirty: series.flagged.filter((sample) => sample.quality === "dirty").length,
      suspect: series.flagged.filter((sample) => sample.quality === "suspect").length,
      breaches: breaches(series, threshold),
      empty: !filled.length
    };
  }, [series, threshold]);

  const metricLabel = t(`admin.telemetry.metric.${metric}`);

  return (
    <>
      <PageHeading
        eyebrow="OPERATIONS / TELEMETRY"
        title={t("admin.nav.telemetry")}
        subtitle={t("admin.telemetry.subtitle")}
        actions={<Button variant="ghost" onClick={() => setNonce((value) => value + 1)} loading={state.status === "loading"}>{t("admin.telemetry.refresh")}</Button>}
      />

      <div className="admin-insight-filters" role="group" aria-label={t("admin.telemetry.filters")}>
        <label className="admin-insight-select">
          <span>{t("admin.branch")}</span>
          <select value={branch} onChange={(event) => set("branch", event.target.value)}>
            {branches.map((item) => <option key={item.id} value={item.id}>{branchName(item.id)}</option>)}
          </select>
        </label>
        <FilterChips
          label={t("admin.telemetry.metricLabel")}
          options={METRICS.map((item) => ({ value: item.key, label: t(`admin.telemetry.metric.${item.key}`) }))}
          value={metric}
          onChange={(value) => set("metric", value)}
        />
        <FilterChips
          label={t("admin.telemetry.range")}
          options={RANGE_KEYS.map((key) => ({ value: key, label: t(`admin.telemetry.ranges.${key}`) }))}
          value={range}
          onChange={(value) => set("range", value)}
        />
      </div>

      <section className="admin-insight-card admin-telemetry" aria-labelledby="telemetry-title">
        <header className="admin-insight-card-head">
          <code>{branch ? branchName(branch) : "—"} · {metric}</code>
          <h2 id="telemetry-title">{metricLabel}</h2>
          <p>
            {threshold
              ? t("admin.telemetry.thresholds", { min: threshold.min !== undefined ? fmt(threshold.min) : "—", max: threshold.max !== undefined ? fmt(threshold.max) : "—" })
              : t("admin.telemetry.noThreshold")}
          </p>
        </header>

        {summary && !summary.empty ? (
          <dl className="admin-telemetry-stats">
            <div><dt>{t("admin.telemetry.latest")}</dt><dd className="mono">{fmt(summary.latest)}</dd></div>
            <div><dt>{t("admin.telemetry.rangeMin")}</dt><dd className="mono">{fmt(summary.min)}</dd></div>
            <div><dt>{t("admin.telemetry.rangeMax")}</dt><dd className="mono">{fmt(summary.max)}</dd></div>
            <div>
              <dt>{t("admin.telemetry.breaches")}</dt>
              <dd>{summary.breaches ? <StatusBadge tone="warn" label={t("admin.telemetry.breachCount", { count: summary.breaches })} /> : <StatusBadge tone="ok" label={t("admin.telemetry.withinLimits")} />}</dd>
            </div>
            <div>
              <dt>{t("admin.telemetry.flagged")}</dt>
              <dd className="mono is-small">{summary.dirty} {t("admin.telemetry.quality.dirty")} · {summary.suspect} {t("admin.telemetry.quality.suspect")}</dd>
            </div>
          </dl>
        ) : null}

        {state.status === "error" ? <ErrorPanel error={state.error} onRetry={() => setNonce((value) => value + 1)} /> : null}
        {(state.status === "loading" || state.status === "idle") && !series ? <div className="admin-telemetry-chart is-loading"><Skeleton lines={6} /></div> : null}
        {series && summary?.empty && state.status !== "error" ? <div className="admin-empty"><EmptyState title={t("admin.telemetry.emptyTitle")} body={t("admin.telemetry.emptyBody")} /></div> : null}
        {series && !summary?.empty && state.status !== "error" ? (
          <div className={state.status === "loading" ? "admin-telemetry-plot is-refreshing" : "admin-telemetry-plot"}>
            <TelemetryChart
              series={series}
              threshold={threshold}
              unit={spec.unit}
              digits={spec.digits}
              bucketMs={RANGES[range].bucket}
              label={t("admin.telemetry.chartLabel", { metric: metricLabel, branch: branchName(branch), range: t(`admin.telemetry.ranges.${range}`), min: fmt(summary?.min), max: fmt(summary?.max), flagged: series.flagged.length })}
            />
          </div>
        ) : null}

        <footer className="admin-insight-foot">
          <span><i className="admin-key is-line" aria-hidden="true" />{t("admin.telemetry.legendAvg")}</span>
          <span><i className="admin-key is-band" aria-hidden="true" />{t("admin.telemetry.legendBand")}</span>
          <span><i className="admin-key is-threshold" aria-hidden="true" />{t("admin.telemetry.legendThreshold")}</span>
          <span><i className="admin-key is-hollow" aria-hidden="true" />{t("admin.telemetry.legendFlagged")}</span>
          {series ? <span className="mono admin-muted">{t("admin.telemetry.sampleCount", { count: series.samples })}</span> : null}
        </footer>
        {series?.truncatedWindows ? (
          <p className="admin-insight-note" role="note">{t("admin.telemetry.truncated", { count: series.truncatedWindows, total: series.windows })}</p>
        ) : null}

        {series && !summary?.empty ? (
          <details className="admin-insight-table">
            <summary>{t("admin.telemetry.tableToggle")}</summary>
            <div className="qa-table-wrap">
              <table className="qa-table">
                <caption className="qa-sr-only">{metricLabel}</caption>
                <thead><tr><th>{t("admin.telemetry.bucket")}</th><th>{t("admin.telemetry.avg")}</th><th>{t("admin.telemetry.min")}</th><th>{t("admin.telemetry.max")}</th><th>{t("admin.telemetry.samples")}</th></tr></thead>
                <tbody>
                  {series.buckets.filter((bucket) => bucket.count).map((bucket) => (
                    <tr key={bucket.ts}>
                      <td className="mono">{bucket.ts.replace("T", " ").slice(0, 16)}</td>
                      <td className="mono">{fmt(bucket.avg)}</td>
                      <td className="mono">{fmt(bucket.min)}</td>
                      <td className="mono">{fmt(bucket.max)}</td>
                      <td className="mono">{bucket.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </section>
    </>
  );
}
