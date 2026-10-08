import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertIcon, CheckIcon, ChevronIcon, CloseIcon, InfoIcon, OfflineIcon, SpinnerIcon } from "./icons";

type Tone = "ok" | "warn" | "danger" | "info" | "offline";

export function Logo() {
  return (
    <div className="qa-logo" aria-label="Unmanned Library">
      <span>UL</span>
    </div>
  );
}

export function Button({
  variant = "primary",
  loading = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; loading?: boolean }) {
  return (
    <button className={`qa-button qa-button-${variant}`} disabled={props.disabled || loading} {...props}>
      {loading ? <SpinnerIcon className="qa-spin" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function TextField({ label, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  const id = props.id ?? props.name ?? label;
  return (
    <label className="qa-field" htmlFor={id}>
      <span>{label}</span>
      <input id={id} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} {...props} />
      {error ? <strong id={`${id}-error`} role="alert">{error}</strong> : null}
    </label>
  );
}

export function Select({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const id = props.id ?? props.name ?? label;
  return (
    <label className="qa-field qa-select" htmlFor={id}>
      <span>{label}</span>
      <select id={id} {...props}>{children}</select>
      <ChevronIcon />
    </label>
  );
}

export function Tabs({ items, value, onChange }: { items: string[]; value: string; onChange: (value: string) => void }) {
  return (
    <div className="qa-tabs" role="tablist" aria-label="Tabs">
      {items.map((item) => (
        <button key={item} role="tab" aria-selected={value === item} onClick={() => onChange(item)}>
          {item}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl({ items, value, onChange }: { items: string[]; value: string; onChange: (value: string) => void }) {
  return (
    <div className="qa-segmented" role="group" aria-label="Segmented control">
      {items.map((item) => (
        <button key={item} aria-pressed={value === item} onClick={() => onChange(item)}>
          {item}
        </button>
      ))}
    </div>
  );
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="qa-card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function CatalogCard({ callNumber, title, meta }: { callNumber: string; title: string; meta: string }) {
  return (
    <article className="qa-catalog-card">
      <div>
        <code>{callNumber}</code>
        <StatusBadge tone="ok" label="在架" />
      </div>
      <h3>{title}</h3>
      <p>{meta}</p>
    </article>
  );
}

export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  const Icon = tone === "ok" ? CheckIcon : tone === "info" ? InfoIcon : tone === "offline" ? OfflineIcon : AlertIcon;
  return (
    <span className={`qa-status qa-status-${tone}`}>
      <Icon />
      {label}
    </span>
  );
}

export function DataTable({ state = "ready" }: { state?: "ready" | "empty" | "loading" | "error" }) {
  const { t } = useTranslation();
  const rows = [
    ["木心谈木心", "I247.5 / M87", "R-2048", t("status.ok")],
    ["Architecture Patterns", "QA76.76 / A73", "R-1842", t("status.warn")],
    ["未来图书馆", "G250 / L52", "R-0871", t("status.info")]
  ];

  return (
    <div className="qa-table-wrap">
      <table className="qa-table">
        <thead>
          <tr>
            {[t("table.book"), t("table.call"), t("table.reader"), t("table.status")].map((header) => (
              <th key={header}><button>{header}<ChevronIcon /></button></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state === "ready" ? rows.map((row) => (
            <tr key={row[1]}>
              <td>{row[0]}</td>
              <td><code>{row[1]}</code></td>
              <td>{row[2]}</td>
              <td><StatusBadge tone={row[3] === t("status.warn") ? "warn" : row[3] === t("status.info") ? "info" : "ok"} label={row[3]} /></td>
            </tr>
          )) : (
            <tr>
              <td colSpan={4}>
                {state === "loading" ? <Skeleton lines={3} /> : (
                  <div className={`qa-table-state qa-table-state-${state}`}>
                    {state === "empty" ? t("table.empty") : t("table.error")}
                  </div>
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function StatCard({ title, value, delta }: { title: string; value: string; delta: string }) {
  return (
    <article className="qa-stat-card">
      <span>{title}</span>
      <strong>{value}</strong>
      <div>
        <small>{delta}</small>
        <svg viewBox="0 0 96 28" aria-label="sparkline">
          <path d="M2 21 C14 14 20 18 30 10 S48 14 58 8 74 12 94 4" />
        </svg>
      </div>
    </article>
  );
}

export function Toast() {
  const { t } = useTranslation();
  return (
    <div className="qa-toast" role="status">
      <CheckIcon />
      <div>
        <strong>{t("toast.title")}</strong>
        <p>{t("toast.body")}</p>
      </div>
    </div>
  );
}

export function Dialog() {
  const { t } = useTranslation();
  return (
    <div className="qa-dialog" role="dialog" aria-modal="false" aria-labelledby="dialog-title">
      <button aria-label="Close dialog"><CloseIcon /></button>
      <h3 id="dialog-title">{t("dialog.title")}</h3>
      <p>{t("dialog.body")}</p>
      <div><Button variant="secondary">{t("action.ghost")}</Button><Button variant="danger">{t("action.danger")}</Button></div>
    </div>
  );
}

export function Drawer() {
  const { t } = useTranslation();
  return (
    <aside className="qa-drawer" aria-label={t("drawer.title")}>
      <h3>{t("drawer.title")}</h3>
      <dl>
        <dt>ID</dt><dd>RFID-GATE-02</dd>
        <dt>IP</dt><dd>10.0.4.18</dd>
        <dt>FW</dt><dd>2.8.1</dd>
      </dl>
    </aside>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="qa-stepper">
      {steps.map((step, index) => (
        <li key={step} aria-current={index === current ? "step" : undefined} data-complete={index < current}>
          <span>{index + 1}</span>
          {step}
        </li>
      ))}
    </ol>
  );
}

export function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="qa-empty">
      <BookSpines seed={8} />
      <h3>{t("empty.title")}</h3>
      <p>{t("empty.body")}</p>
    </div>
  );
}

export function Skeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="qa-skeleton" aria-label="Loading">
      {Array.from({ length: lines }, (_, index) => <span key={index} />)}
    </div>
  );
}

export function LangSwitch() {
  const { i18n, t } = useTranslation();
  return (
    <SegmentedControl
      items={[t("lang.zh"), t("lang.en")]}
      value={i18n.language === "zh-CN" ? t("lang.zh") : t("lang.en")}
      onChange={(label) => void i18n.changeLanguage(label === t("lang.zh") ? "zh-CN" : "en")}
    />
  );
}

export function ThemeSwitch({ mode, onModeChange }: { mode: "light" | "dark" | "kiosk"; onModeChange: (mode: "light" | "dark" | "kiosk") => void }) {
  const { t } = useTranslation();
  const labels = [t("theme.light"), t("theme.dark"), t("theme.kiosk")];
  return (
    <SegmentedControl
      items={labels}
      value={mode === "light" ? labels[0] : mode === "dark" ? labels[1] : labels[2]}
      onChange={(label) => onModeChange(label === labels[1] ? "dark" : label === labels[2] ? "kiosk" : "light")}
    />
  );
}

export function BookSpines({ seed = 4 }: { seed?: number }) {
  const bars = useMemo(() => {
    let value = seed * 9301 + 49297;
    return Array.from({ length: 14 }, (_, index) => {
      value = (value * 233 + 71) % 997;
      return { height: 22 + (value % 42), y: 8 + (index % 3) * 3, width: index % 4 === 0 ? 4 : 2 };
    });
  }, [seed]);

  return (
    <svg className="qa-spines" viewBox="0 0 120 78" role="img" aria-label="Book spine motif">
      <line x1="8" y1="70" x2="112" y2="70" />
      {bars.map((bar, index) => (
        <rect key={index} x={12 + index * 7} y={70 - bar.height - bar.y} width={bar.width} height={bar.height} rx="1" />
      ))}
    </svg>
  );
}

export function ShowcasePage() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"light" | "dark" | "kiosk">(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("mode") === "dark" ? "dark" : params.get("mode") === "kiosk" ? "kiosk" : "light";
  });
  const [tab, setTab] = useState(t("tabs.overview"));
  const [segment, setSegment] = useState(t("seg.today"));
  const theme = mode === "dark" ? "dark" : "light";

  return (
    <main className={`qa-showcase ${mode === "kiosk" ? "qa-kiosk" : ""}`} data-theme={theme}>
      <header className="qa-showcase-header">
        <div>
          <Logo />
          <div>
            <p>{t("app.name")}</p>
            <h1>{t("design.title")}</h1>
            <span>{t("design.subtitle")}</span>
          </div>
        </div>
        <div aria-label={t("design.controls")}>
          <LangSwitch />
          <ThemeSwitch mode={mode} onModeChange={setMode} />
        </div>
      </header>

      <section className="qa-grid">
        <Card title={t("design.buttons")}>
          <div className="qa-row">
            <Button>{t("action.confirm")}</Button>
            <Button variant="secondary">{t("action.secondary")}</Button>
            <Button variant="ghost">{t("action.ghost")}</Button>
            <Button variant="danger">{t("action.danger")}</Button>
            <Button loading>{t("action.loading")}</Button>
            <Button disabled>{t("action.disabled")}</Button>
          </div>
        </Card>

        <Card title={t("design.forms")}>
          <div className="qa-form-grid">
            <TextField label={t("field.reader")} placeholder={t("field.reader.placeholder")} />
            <TextField label={t("field.reader")} value="R-2048" error="证件状态需复核" readOnly />
            <Select label={t("field.branch")} defaultValue="north"><option value="north">北馆</option><option value="south">南馆</option></Select>
          </div>
        </Card>

        <Card title={t("design.navigation")}>
          <Tabs items={[t("tabs.overview"), t("tabs.devices"), t("tabs.loans")]} value={tab} onChange={setTab} />
          <SegmentedControl items={[t("seg.today"), t("seg.week"), t("seg.month")]} value={segment} onChange={setSegment} />
          <Stepper steps={[t("step.one"), t("step.two"), t("step.three")]} current={1} />
        </Card>

        <Card title={t("design.surfaces")}>
          <div className="qa-status-row">
            <StatusBadge tone="ok" label={t("status.ok")} />
            <StatusBadge tone="warn" label={t("status.warn")} />
            <StatusBadge tone="danger" label={t("status.danger")} />
            <StatusBadge tone="info" label={t("status.info")} />
            <StatusBadge tone="offline" label={t("status.offline")} />
          </div>
          <CatalogCard callNumber="I247.5 / M87" title="木心谈木心" meta="文学 / 二层东区 / RFID 0048" />
        </Card>

        <Card title={t("design.data")}>
          <div className="qa-stats">
            <StatCard title={t("stat.loans")} value="428" delta={t("stat.delta")} />
            <StatCard title="在线设备" value="96.8%" delta="3 faults" />
          </div>
          <DataTable />
          <div className="qa-state-grid">
            <DataTable state="empty" />
            <DataTable state="loading" />
            <DataTable state="error" />
          </div>
        </Card>

        <Card title={t("design.feedback")}>
          <div className="qa-feedback-grid">
            <Toast />
            <Dialog />
            <Drawer />
          </div>
        </Card>

        <Card title={t("design.workflow")}>
          <EmptyState />
          <Skeleton lines={4} />
        </Card>
      </section>
    </main>
  );
}
