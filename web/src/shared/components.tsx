import type { ButtonHTMLAttributes, ComponentProps, KeyboardEvent, ReactNode, SelectHTMLAttributes } from "react";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertIcon, BellIcon, CheckIcon, ChevronIcon, CloseIcon, InfoIcon, OfflineIcon, SpinnerIcon } from "./icons";
import { animate, BookSpinesBand, easing, prefersReducedMotion, useStagger } from "./motion";

type Tone = "ok" | "warn" | "danger" | "info" | "offline";
export type BookStatus = "in" | "borrowed" | "overdue" | "repair";

function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(" ");
}

export function Logo() {
  const { t } = useTranslation();
  return (
    <div className="qa-logo" aria-label={t("app.name")}>
      <span>{t("app.logo")}</span>
    </div>
  );
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "md" | "lg"; loading?: boolean }) {
  return (
    <button
      className={cx("qa-button", `qa-button-${variant}`, size === "lg" && "qa-button-lg", loading && "is-loading", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <SpinnerIcon className="qa-spin" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function TextField({
  label,
  hint,
  error,
  mono = false,
  ...props
}: ComponentProps<"input"> & { label: string; hint?: string; error?: string; mono?: boolean }) {
  const autoId = useId();
  const id = props.id ?? props.name ?? autoId;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <label className={cx("qa-field", mono && "is-mono")} htmlFor={id}>
      <span>{label}</span>
      <input id={id} aria-invalid={Boolean(error)} aria-describedby={describedBy} {...props} />
      {error ? <strong id={`${id}-error`} role="alert">{error}</strong> : hint ? <small id={`${id}-hint`}>{hint}</small> : null}
    </label>
  );
}

export function Select({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const autoId = useId();
  const id = props.id ?? props.name ?? autoId;
  return (
    <label className="qa-field qa-select" htmlFor={id}>
      <span>{label}</span>
      <select id={id} {...props}>{children}</select>
      <ChevronIcon />
    </label>
  );
}

type TabItem = string | { value: string; label: ReactNode };

/**
 * Folder tabs: the selected tab joins the paper panel below it.
 * With `idPrefix`, tab ids are `${idPrefix}-tab-${value}` and point at panels `${idPrefix}-panel-${value}`.
 */
export function Tabs({ items, value, onChange, label, idPrefix }: { items: TabItem[]; value: string; onChange: (value: string) => void; label?: string; idPrefix?: string }) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const options = items.map((item) => (typeof item === "string" ? { value: item, label: item } : item));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    const index = options.findIndex((option) => option.value === value);
    let next = -1;
    if (event.key in keys) next = (index + keys[event.key] + options.length) % options.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = options.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(options[next].value);
    listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };

  return (
    <div ref={listRef} className="qa-tabs" role="tablist" aria-label={label ?? t("tabs.label")} onKeyDown={onKeyDown}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          id={idPrefix ? `${idPrefix}-tab-${option.value}` : undefined}
          aria-controls={idPrefix ? `${idPrefix}-panel-${option.value}` : undefined}
          aria-selected={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl({ items, value, onChange, label }: { items: string[]; value: string; onChange: (value: string) => void; label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="qa-segmented" role="group" aria-label={label ?? t("segmented.label")}>
      {items.map((item) => (
        <button key={item} type="button" aria-pressed={value === item} onClick={() => onChange(item)}>
          {item}
        </button>
      ))}
    </div>
  );
}

export function Card({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("qa-card", className)}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const TONE_ICONS = { ok: CheckIcon, warn: AlertIcon, danger: AlertIcon, info: InfoIcon, offline: OfflineIcon } as const;

/**
 * Book status (`status`: in stock / borrowed / overdue / repair) or a generic system tone (`tone`).
 * Overdue gently pulses.
 */
export function StatusBadge(props: { status: BookStatus; label?: string } | { tone: Tone; label: string }) {
  const { t } = useTranslation();
  if ("status" in props) {
    return (
      <span className={cx("qa-badge", `qa-badge-${props.status}`)}>
        <i aria-hidden="true" />
        {props.label ?? t(`book.status.${props.status}`)}
      </span>
    );
  }
  const Icon = TONE_ICONS[props.tone];
  return (
    <span className={cx("qa-badge", `qa-badge-tone-${props.tone}`)}>
      <Icon />
      {props.label}
    </span>
  );
}

/** Library catalogue card: burgundy spine strip, serif title, call number in mono. */
export function CatalogCard({
  callNumber,
  title,
  author,
  location,
  status,
  meta,
  children
}: {
  callNumber: string;
  title: string;
  author?: string;
  location?: string;
  status?: BookStatus;
  meta?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <article className="qa-catalog-card">
      <i aria-hidden="true" />
      <div>
        <header>
          <code>{callNumber}</code>
          {status ? <StatusBadge status={status} /> : null}
        </header>
        <h3>{title}</h3>
        {meta ? <p>{meta}</p> : null}
        {author || location ? (
          <dl>
            {author ? <><dt>{t("catalog.author")}</dt><dd>{author}</dd></> : null}
            <dt>{t("catalog.callNumber")}</dt><dd className="mono">{callNumber}</dd>
            {location ? <><dt>{t("catalog.location")}</dt><dd>{location}</dd></> : null}
          </dl>
        ) : null}
        {children}
      </div>
    </article>
  );
}

export type Column<Row> = {
  key: string;
  header: ReactNode;
  render?: (row: Row) => ReactNode;
  mono?: boolean;
};

export function DataTable<Row extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  state = "ready",
  caption,
  emptyText,
  errorText,
  selectedKey,
  onRowClick
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  state?: "ready" | "loading" | "error";
  caption?: string;
  emptyText?: string;
  errorText?: string;
  selectedKey?: string | null;
  onRowClick?: (row: Row) => void;
}) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  useStagger(bodyRef, [rows, state], { step: 60, distance: 12, duration: 450 });

  const message = state === "error" ? errorText ?? t("table.error") : !rows.length && state === "ready" ? emptyText ?? t("table.empty") : null;

  return (
    <div className="qa-table-wrap">
      <table className="qa-table">
        {caption ? <caption className="qa-sr-only">{caption}</caption> : null}
        <thead>
          <tr>{columns.map((column) => <th key={column.key} scope="col">{column.header}</th>)}</tr>
        </thead>
        <tbody ref={bodyRef} aria-busy={state === "loading" || undefined}>
          {state === "loading" ? (
            <tr><td colSpan={columns.length}><Skeleton lines={3} /></td></tr>
          ) : message ? (
            <tr><td colSpan={columns.length}><div className={cx("qa-table-state", state === "error" && "is-error")}>{message}</div></td></tr>
          ) : rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={cx(onRowClick && "is-clickable", selectedKey === key && "is-selected")}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRowClick(row); } } : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.mono ? "mono" : undefined}>
                    {column.render ? column.render(row) : String(row[column.key] ?? "")}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function StatCard({ title, value, delta }: { title: string; value: ReactNode; delta?: string }) {
  return (
    <article className="qa-stat-card">
      <span>{title}</span>
      <strong>{value}</strong>
      {delta ? <small>{delta}</small> : null}
    </article>
  );
}

/** Side drawer with a wooden edge. `contained` positions it inside the nearest positioned parent. */
export function Drawer({
  open,
  onClose,
  title,
  children,
  contained = false
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  contained?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <aside
      className={cx("qa-drawer", contained && "is-contained")}
      data-open={open}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-hidden={!open}
      inert={!open}
    >
      <button ref={closeRef} type="button" className="qa-drawer-close" onClick={onClose} aria-label={t("action.close")}><CloseIcon /></button>
      <h3 id={titleId}>{title}</h3>
      {children}
    </aside>
  );
}

export function Dialog({ title, body, actions }: { title: string; body: string; actions?: ReactNode }) {
  const titleId = useId();
  return (
    <div className="qa-dialog" role="dialog" aria-modal="false" aria-labelledby={titleId}>
      <h3 id={titleId}>{title}</h3>
      <p>{body}</p>
      {actions ? <div>{actions}</div> : null}
    </div>
  );
}

type ToastTone = "info" | "success" | "alert";
type ToastInput = { title: string; body?: string; tone?: ToastTone; duration?: number };
type ToastItem = ToastInput & { id: number; leaving: boolean };

const TOAST_ICONS = { info: InfoIcon, success: CheckIcon, alert: BellIcon } as const;

/** A single toast; slides in from above on mount and out again when `leaving` becomes true. */
export function Toast({ title, body, tone = "info", leaving = false, onClose, onExited }: ToastInput & { leaving?: boolean; onClose?: () => void; onExited?: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const Icon = TOAST_ICONS[tone];
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  useLayoutEffect(() => {
    const animation = animate(ref.current, [{ opacity: 0, transform: "translateY(-90px)" }, { opacity: 1, transform: "none" }], { duration: 450, easing: easing.spring, fill: "backwards" });
    return () => animation?.cancel();
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const animation = animate(ref.current, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-24px) scale(.96)" }], { duration: 260, easing: easing.out, fill: "forwards" });
    if (!animation) {
      onExitedRef.current?.();
      return;
    }
    animation.onfinish = () => onExitedRef.current?.();
    return () => animation.cancel();
  }, [leaving]);

  return (
    <div ref={ref} className={cx("qa-toast", `qa-toast-${tone}`)} role={tone === "alert" ? "alert" : "status"}>
      <Icon />
      <div>
        <strong>{title}</strong>
        {body ? <p>{body}</p> : null}
      </div>
      {onClose ? <button type="button" onClick={onClose} aria-label={t("action.close")}><CloseIcon /></button> : null}
    </div>
  );
}

const ToastContext = createContext<(toast: ToastInput) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    if (prefersReducedMotion()) setItems((list) => list.filter((item) => item.id !== id));
    else setItems((list) => list.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
  }, []);

  const remove = useCallback((id: number) => setItems((list) => list.filter((item) => item.id !== id)), []);

  const push = useCallback((toast: ToastInput) => {
    const id = nextId.current++;
    setItems((list) => [...list.slice(-3), { ...toast, id, leaving: false }]);
    timers.current.set(id, window.setTimeout(() => dismiss(id), toast.duration ?? 3600));
  }, [dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="qa-toast-viewport" aria-live="polite">
        {items.map((item) => (
          <Toast key={item.id} {...item} onClose={() => dismiss(item.id)} onExited={() => remove(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="qa-stepper">
      {steps.map((step, index) => (
        <li key={step} aria-current={index === current ? "step" : undefined} data-state={index < current ? "done" : index === current ? "current" : "todo"}>
          <span aria-hidden="true">{index < current ? "✓" : index + 1}</span>
          {step}
        </li>
      ))}
    </ol>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="qa-empty">
      <BookSpinesBand count={12} height={34} className="is-small" />
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({ lines = 2 }: { lines?: number }) {
  const { t } = useTranslation();
  return (
    <div className="qa-skeleton" role="status" aria-label={t("state.loading")}>
      {Array.from({ length: lines }, (_, index) => <span key={index} />)}
    </div>
  );
}

export function LangSwitch() {
  const { i18n, t } = useTranslation();
  return (
    <SegmentedControl
      label={t("lang.label")}
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
      label={t("theme.label")}
      items={labels}
      value={mode === "light" ? labels[0] : mode === "dark" ? labels[1] : labels[2]}
      onChange={(label) => onModeChange(label === labels[1] ? "dark" : label === labels[2] ? "kiosk" : "light")}
    />
  );
}

/** Static SVG shelf used by the kiosk idle and empty screens. */
export function BookSpines({ seed = 4 }: { seed?: number }) {
  const { t } = useTranslation();
  const bars = useMemo(() => {
    let value = seed * 9301 + 49297;
    return Array.from({ length: 14 }, (_, index) => {
      value = (value * 233 + 71) % 997;
      return { height: 22 + (value % 42), y: 8 + (index % 3) * 3, width: index % 4 === 0 ? 4 : 2 };
    });
  }, [seed]);

  return (
    <svg className="qa-spines" viewBox="0 0 120 78" role="img" aria-label={t("motif.spines")}>
      <line x1="8" y1="70" x2="112" y2="70" />
      {bars.map((bar, index) => (
        <rect key={index} x={12 + index * 7} y={70 - bar.height - bar.y} width={bar.width} height={bar.height} rx="1" />
      ))}
    </svg>
  );
}
