import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, DataTable, EmptyState, StatusBadge, useToast, type Column } from "../shared/components";
import { useAdmin } from "./adminContext";
import { ErrorPanel, errorText, FilterChips, PageHeading, RelativeTime } from "./adminUi";
import {
  collectExport, DATASETS, EXPORT_ROW_CAP, exportFilename, fetchExportHistory, METRICS, recordExport,
  type DatasetKey, type ExportQuery, type ExportRecord, type ExportResult
} from "./insightApi";
import { buildXlsx, downloadBytes, type Cell } from "./xlsx";
import "./ops.css";
import "./insight.css";

const PRESETS = ["7d", "30d", "90d", "365d", "all", "custom"] as const;
type Preset = (typeof PRESETS)[number];
const PREVIEW_ROWS = 20;

export function localDay(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function presetRange(preset: Preset, now = new Date()): { from: string | null; to: string | null } {
  if (preset === "all" || preset === "custom") return { from: null, to: null };
  const days = Number.parseInt(preset, 10);
  const from = new Date(now);
  from.setDate(from.getDate() - days + 1);
  return { from: localDay(from), to: localDay(now) };
}

const queryKey = (query: ExportQuery) => JSON.stringify([query.dataset, query.branchId, query.from, query.to, query.dataset === "telemetry" ? query.metric : null]);

export function ExportsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { user, branches, branchId: shellBranch, branchName } = useAdmin();
  const [dataset, setDataset] = useState<DatasetKey>("loans");
  const [branchId, setBranchId] = useState(shellBranch);
  const [metric, setMetric] = useState("all");
  const [preset, setPreset] = useState<Preset>("30d");
  const [range, setRange] = useState(() => presetRange("30d"));
  const [preview, setPreview] = useState<{ status: "idle" | "loading" | "ready" | "error"; key?: string; result?: ExportResult; error?: unknown; progress?: number }>({ status: "idle" });
  const [downloading, setDownloading] = useState(false);
  const [history, setHistory] = useState<{ status: "loading" | "ready" | "error"; rows: ExportRecord[]; error?: unknown }>({ status: "loading", rows: [] });
  const [historyNonce, setHistoryNonce] = useState(0);
  const run = useRef(0);

  useEffect(() => setBranchId(shellBranch), [shellBranch]);

  useEffect(() => {
    let alive = true;
    fetchExportHistory()
      .then((rows) => { if (alive) setHistory({ status: "ready", rows }); })
      .catch((error) => { if (alive) setHistory({ status: "error", rows: [], error }); });
    return () => { alive = false; };
  }, [historyNonce]);

  const spec = DATASETS.find((item) => item.key === dataset)!;
  const query: ExportQuery = { dataset, branchId: spec.branchFilter ? branchId : "all", from: spec.dateField ? range.from : null, to: spec.dateField ? range.to : null, metric: dataset === "telemetry" ? metric : undefined };
  const key = queryKey(query);
  const stale = preview.status === "ready" && preview.key !== key;
  const rangeInvalid = Boolean(query.from && query.to && query.from > query.to) || (dataset === "telemetry" && !query.from);

  // Catalogue-style datasets are mostly old rows; telemetry needs a bounded range (raw samples).
  function pickDataset(next: DatasetKey) {
    setDataset(next);
    const wanted: Preset | null = (next === "books" || next === "readers") ? "all" : next === "telemetry" && (preset === "all" || preset === "365d") ? "7d" : null;
    if (wanted) { setPreset(wanted); setRange(presetRange(wanted)); }
  }

  async function collect(target: ExportQuery) {
    const id = ++run.current;
    setPreview({ status: "loading", key: queryKey(target), progress: 0 });
    try {
      const result = await collectExport(target, branches.map((item) => item.id), (rows) => { if (run.current === id) setPreview((previous) => ({ ...previous, progress: rows })); });
      if (run.current === id) setPreview({ status: "ready", key: queryKey(target), result });
      return result;
    } catch (error) {
      if (run.current === id) setPreview({ status: "error", key: queryKey(target), error });
      throw error;
    }
  }

  async function download(target: ExportQuery) {
    setDownloading(true);
    try {
      const result = preview.status === "ready" && preview.key === queryKey(target) ? preview.result! : await collect(target);
      const targetSpec = DATASETS.find((item) => item.key === target.dataset)!;
      const branch = target.branchId === "all" ? null : branches.find((item) => item.id === target.branchId);
      const now = new Date();
      const filename = exportFilename(target, branch?.code ?? "ALL", now);
      const rangeText = target.from || target.to ? `${target.from ?? "…"} – ${target.to ?? "…"}` : t("admin.exports.allTime");
      const bytes = buildXlsx([
        {
          name: target.dataset,
          header: targetSpec.columns.map((column) => column.key),
          widths: targetSpec.columns.map((column) => column.width),
          rows: result.rows.map((row) => targetSpec.columns.map((column): Cell => {
            const value = row[column.key];
            if (column.number) return typeof value === "number" ? value : value === null || value === undefined || value === "" ? null : Number(value);
            return value === null || value === undefined ? null : String(value);
          }))
        },
        {
          name: t("admin.exports.aboutSheet"),
          header: [t("admin.exports.field"), t("admin.exports.value")],
          widths: [22, 60],
          rows: [
            [t("admin.exports.dataset"), t(`admin.exports.datasets.${target.dataset}`)],
            [t("admin.branch"), branch ? branchName(branch.id) : t("admin.allBranches")],
            [t("admin.exports.range"), rangeText],
            ...(target.dataset === "telemetry" ? [[t("admin.telemetry.metricLabel"), target.metric === "all" || !target.metric ? t("admin.exports.allMetrics") : target.metric]] as Cell[][] : []),
            [t("admin.exports.rows"), result.rows.length],
            [t("admin.exports.generatedAt"), now.toISOString()],
            [t("admin.exports.generatedBy"), `${user.name} (${user.account})`],
            [t("admin.exports.source"), t("admin.exports.sourceText")],
            ...(result.capped ? [[t("admin.exports.note"), t("admin.exports.capped", { cap: EXPORT_ROW_CAP })]] as Cell[][] : [])
          ]
        }
      ], now);
      downloadBytes(bytes, filename);
      await recordExport({ ...target, at: now.toISOString(), by: user.name, rows: result.rows.length, filename });
      setHistoryNonce((value) => value + 1);
      toast({ tone: "success", title: t("admin.exports.done"), body: filename });
    } catch (error) {
      toast({ tone: "alert", title: t("admin.exports.failed"), body: errorText(t, error) });
    } finally {
      setDownloading(false);
    }
  }

  const previewColumns: Column<Record<string, unknown>>[] = useMemo(() => spec.columns.map((column) => ({
    key: column.key,
    header: <span className="mono">{column.key}</span>,
    mono: column.number || /(_at|_id|^id|ts|tag|isbn)$/.test(column.key),
    render: (row) => {
      const value = row[column.key];
      if (value === null || value === undefined || value === "") return <span className="admin-muted">—</span>;
      const text = String(value);
      return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.replace("T", " ").slice(0, 16) : <span className="admin-clamp">{text}</span>;
    }
  })), [spec]);

  const result = preview.status === "ready" && !stale ? preview.result : undefined;

  return (
    <>
      <PageHeading eyebrow="QUALITY / EXPORTS" title={t("admin.nav.exports")} subtitle={t("admin.exports.subtitle")} />

      <div className="admin-exports">
        <form className="admin-form admin-export-form" onSubmit={(event) => { event.preventDefault(); void collect(query); }} aria-labelledby="export-form-title">
          <h2 id="export-form-title">{t("admin.exports.formTitle")}</h2>

          <fieldset className="admin-dataset-pick">
            <legend>{t("admin.exports.dataset")}</legend>
            {DATASETS.map((item) => (
              <label key={item.key} className={item.key === dataset ? "is-selected" : undefined}>
                <input type="radio" name="dataset" value={item.key} checked={item.key === dataset} onChange={() => pickDataset(item.key)} />
                <span>
                  <b>{t(`admin.exports.datasets.${item.key}`)}</b>
                  <small>{t(`admin.exports.datasetDesc.${item.key}`)}</small>
                </span>
                <code>{item.path}</code>
              </label>
            ))}
          </fieldset>

          <label htmlFor="export-branch">{t("admin.branch")}</label>
          <select id="export-branch" value={spec.branchFilter ? branchId : "all"} disabled={!spec.branchFilter} onChange={(event) => setBranchId(event.target.value)}>
            <option value="all">{t("admin.allBranches")}</option>
            {branches.map((item) => <option key={item.id} value={item.id}>{branchName(item.id)}</option>)}
          </select>
          {!spec.branchFilter ? <small className="admin-muted">{t("admin.exports.noBranch")}</small> : null}

          {dataset === "telemetry" ? (
            <>
              <label htmlFor="export-metric">{t("admin.telemetry.metricLabel")}</label>
              <select id="export-metric" value={metric} onChange={(event) => setMetric(event.target.value)}>
                <option value="all">{t("admin.exports.allMetrics")}</option>
                {METRICS.map((item) => <option key={item.key} value={item.key}>{t(`admin.telemetry.metric.${item.key}`)}</option>)}
              </select>
            </>
          ) : null}

          <span className="admin-export-label">{t("admin.exports.range")}{spec.dateField ? <code>{spec.dateField}</code> : null}</span>
          {spec.dateField ? (
            <>
              <FilterChips
                label={t("admin.exports.range")}
                options={PRESETS.filter((value) => dataset !== "telemetry" || (value !== "all" && value !== "365d")).map((value) => ({ value, label: t(`admin.exports.presets.${value}`) }))}
                value={preset}
                onChange={(value) => { setPreset(value); if (value !== "custom") setRange(presetRange(value)); }}
              />
              <div className="admin-form-pair">
                <div>
                  <label htmlFor="export-from">{t("admin.exports.from")}</label>
                  <input id="export-from" type="date" value={range.from ?? ""} max={range.to ?? undefined} aria-invalid={rangeInvalid} onChange={(event) => { setPreset("custom"); setRange((value) => ({ ...value, from: event.target.value || null })); }} />
                </div>
                <div>
                  <label htmlFor="export-to">{t("admin.exports.to")}</label>
                  <input id="export-to" type="date" value={range.to ?? ""} min={range.from ?? undefined} aria-invalid={rangeInvalid} onChange={(event) => { setPreset("custom"); setRange((value) => ({ ...value, to: event.target.value || null })); }} />
                </div>
              </div>
              {rangeInvalid ? <strong role="alert">{dataset === "telemetry" && !query.from ? t("admin.exports.telemetryFrom") : t("admin.exports.rangeInvalid")}</strong> : null}
            </>
          ) : <small className="admin-muted">{t("admin.exports.noRange")}</small>}

          <div className="admin-export-actions">
            <Button type="submit" variant="ghost" disabled={rangeInvalid} loading={preview.status === "loading" && !downloading}>{t("admin.exports.preview")}</Button>
            <Button type="button" disabled={rangeInvalid} loading={downloading} onClick={() => void download(query)}>{t("admin.exports.download")}</Button>
          </div>
        </form>

        <section className="admin-insight-card admin-export-preview" aria-labelledby="export-preview-title" aria-busy={preview.status === "loading" || undefined}>
          <header className="admin-insight-card-head">
            <code>{spec.path}{query.branchId !== "all" ? `?branchId=${query.branchId}` : ""}</code>
            <h2 id="export-preview-title">{t("admin.exports.previewTitle", { dataset: t(`admin.exports.datasets.${dataset}`) })}</h2>
            {result ? (
              <p>
                {t("admin.exports.matched", { count: result.rows.length })}
                {result.rows.length > PREVIEW_ROWS ? ` · ${t("admin.exports.showing", { count: PREVIEW_ROWS })}` : ""}
              </p>
            ) : null}
          </header>
          {preview.status === "loading" ? <p className="admin-insight-note" role="status">{t("admin.exports.loading", { count: preview.progress ?? 0 })}</p> : null}
          {preview.status === "error" && !stale ? <ErrorPanel error={preview.error} onRetry={() => void collect(query).catch(() => undefined)} /> : null}
          {result?.capped ? <p className="admin-insight-note" role="note">{t("admin.exports.capped", { cap: EXPORT_ROW_CAP })}</p> : null}
          {result ? (
            result.rows.length
              ? <DataTable columns={previewColumns} rows={result.rows.slice(0, PREVIEW_ROWS)} rowKey={(row) => String(row.id ?? JSON.stringify(row))} caption={t("admin.exports.previewTitle", { dataset })} />
              : <div className="admin-empty"><EmptyState title={t("admin.exports.emptyTitle")} body={t("admin.exports.emptyBody")} /></div>
          ) : preview.status !== "loading" ? (
            <div className="admin-empty"><EmptyState title={stale ? t("admin.exports.staleTitle") : t("admin.exports.idleTitle")} body={t("admin.exports.idleBody")} /></div>
          ) : null}
        </section>
      </div>

      <section className="admin-insight-card admin-export-history" aria-labelledby="export-history-title">
        <header className="admin-insight-card-head">
          <code>/api/exports</code>
          <h2 id="export-history-title">{t("admin.exports.history")}</h2>
          {history.rows.some((row) => row.local) ? <p>{t("admin.exports.historyLocal")}</p> : null}
        </header>
        {history.status === "error" ? <ErrorPanel error={history.error} onRetry={() => setHistoryNonce((value) => value + 1)} /> : (
          <DataTable<ExportRecord>
            state={history.status === "loading" ? "loading" : "ready"}
            rows={history.rows}
            rowKey={(row) => row.id}
            caption={t("admin.exports.history")}
            emptyText={t("admin.exports.historyEmpty")}
            columns={[
              { key: "at", header: t("admin.exports.when"), render: (row) => <RelativeTime value={row.at} /> },
              { key: "dataset", header: t("admin.exports.dataset"), render: (row) => t(`admin.exports.datasets.${row.dataset}`) },
              { key: "branch", header: t("admin.branch"), render: (row) => (row.branchId === "all" ? t("admin.allBranches") : branchName(row.branchId)) },
              { key: "range", header: t("admin.exports.range"), mono: true, render: (row) => (row.from || row.to ? `${row.from ?? "…"} – ${row.to ?? "…"}` : t("admin.exports.allTime")) },
              { key: "rows", header: t("admin.exports.rows"), mono: true, render: (row) => <StatusBadge tone="ok" label={String(row.rows)} /> },
              { key: "by", header: t("admin.exports.generatedBy") },
              { key: "filename", header: t("admin.exports.file"), mono: true, render: (row) => <span className="admin-clamp">{row.filename}</span> },
              { key: "again", header: <span className="qa-sr-only">{t("admin.exports.again")}</span>, render: (row) => (
                <Button variant="ghost" disabled={downloading} onClick={() => void download({ dataset: row.dataset, branchId: row.branchId, from: row.from, to: row.to, metric: row.metric })}>{t("admin.exports.again")}</Button>
              ) }
            ]}
          />
        )}
      </section>
    </>
  );
}
