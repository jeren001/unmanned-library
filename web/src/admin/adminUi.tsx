import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, DataTable, EmptyState, type Column } from "../shared/components";
import { AlertIcon } from "../shared/icons";
import { ApiError, type Page, type PageQuery } from "./adminApi";

export const PAGE_SIZE = 20;

export function formatDate(value?: string | null) {
  if (!value) return "—";
  return value.slice(0, 10);
}

export function useDebounced<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

type ListState<T> = { status: "loading" | "ready" | "error"; rows: T[]; hasNext: boolean; error?: unknown };

/** Loads one server-side page; resets to page 1 whenever the filters change. */
export function usePagedList<T>(load: (query: PageQuery) => Promise<Page<T>>, filters: Omit<PageQuery, "page" | "pageSize">) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState<ListState<T>>({ status: "loading", rows: [], hasNext: false });
  const [nonce, setNonce] = useState(0);
  const filterKey = JSON.stringify(filters);
  const lastFilterKey = useRef(filterKey);
  const loadRef = useRef(load);
  loadRef.current = load;

  if (lastFilterKey.current !== filterKey) {
    lastFilterKey.current = filterKey;
    if (page !== 1) setPage(1);
  }

  useEffect(() => {
    let cancelled = false;
    setState((previous) => ({ ...previous, status: "loading" }));
    loadRef.current({ ...filters, page, pageSize: PAGE_SIZE })
      .then((result) => { if (!cancelled) setState({ status: "ready", rows: result.rows, hasNext: result.hasNext }); })
      .catch((error) => { if (!cancelled) setState({ status: "error", rows: [], hasNext: false, error }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, page, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, page, setPage, reload };
}

export function errorText(t: (key: string) => string, error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 0) return t("admin.error.network");
    if (error.status === 401) return t("admin.error.session");
    if (error.status === 403) return t("admin.error.forbidden");
  }
  return t("admin.error.generic");
}

/** Error panel in the catalogue-card language with a retry button. */
export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="admin-error" role="alert">
      <span aria-hidden="true" />
      <AlertIcon />
      <div>
        <strong>{t("admin.error.title")}</strong>
        <p>{errorText(t, error)}</p>
      </div>
      <Button variant="ghost" onClick={onRetry}>{t("admin.retry")}</Button>
    </div>
  );
}

export function FilterChips<V extends string>({ label, options, value, onChange }: { label: string; options: Array<{ value: V; label: string }>; value: V; onChange: (value: V) => void }) {
  return (
    <div className="admin-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="admin-search">
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" /><path d="M14 14l4 4" /></svg>
      <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </label>
  );
}

export function Pager({ page, hasNext, onPage, disabled }: { page: number; hasNext: boolean; onPage: (page: number) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <nav className="admin-pager" aria-label={t("admin.pager.label")}>
      <button type="button" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>← {t("admin.pager.prev")}</button>
      <span className="mono">{t("admin.pager.page", { page })}</span>
      <button type="button" disabled={disabled || !hasNext} onClick={() => onPage(page + 1)}>{t("admin.pager.next")} →</button>
    </nav>
  );
}

/** Table with designed loading, empty and error states plus pagination. */
export function ListView<T extends Record<string, unknown>>({
  list,
  columns,
  rowKey,
  caption,
  selectedKey,
  onRowClick,
  emptyTitle,
  emptyBody,
  emptyAction
}: {
  list: ReturnType<typeof usePagedList<T>>;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  caption: string;
  selectedKey?: string | null;
  onRowClick: (row: T) => void;
  emptyTitle: string;
  emptyBody: string;
  emptyAction?: ReactNode;
}) {
  if (list.status === "error") return <ErrorPanel error={list.error} onRetry={list.reload} />;
  if (list.status === "ready" && !list.rows.length && list.page === 1) {
    return <div className="admin-empty"><EmptyState title={emptyTitle} body={emptyBody} action={emptyAction} /></div>;
  }
  return (
    <div className="admin-list">
      <DataTable columns={columns} rows={list.rows} rowKey={rowKey} state={list.status === "loading" ? "loading" : "ready"} caption={caption} selectedKey={selectedKey} onRowClick={onRowClick} />
      <Pager page={list.page} hasNext={list.hasNext} onPage={list.setPage} disabled={list.status === "loading"} />
    </div>
  );
}

export function PageHeading({ eyebrow, title, subtitle, actions }: { eyebrow: string; title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="admin-page-heading">
      <div>
        <p>{eyebrow}</p>
        <h1>{title}</h1>
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      {actions ? <div className="admin-page-actions">{actions}</div> : null}
    </header>
  );
}
