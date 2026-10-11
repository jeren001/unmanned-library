import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { Button, EmptyState, Skeleton, StatusBadge } from "../shared/components";
import { StaggerList } from "../shared/motion";
import type { BookRow } from "./adminApi";
import { useAdmin } from "./adminContext";
import { ClipPlayer } from "./AlertsPage";
import { BookBadge, LoanBadge } from "./ListPages";
import { ErrorPanel, PageHeading } from "./adminUi";
import { fetchTrace, findLoan, searchBooks, TraceNotFound, type TraceChain, type TraceDeviceEvent } from "./insightApi";
import "./ops.css";
import "./insight.css";

const LOAN_ID = /^loan-[\w-]+$/i;

function stamp(value?: string | null) {
  return value ? value.replace("T", " ").slice(0, 16) : "—";
}

type Search = { status: "idle" | "loading" | "ready" | "error"; books: BookRow[]; error?: unknown; missing?: string };

export function TracePage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const bookId = params.get("book");
  const loanId = params.get("loan");
  const [text, setText] = useState(params.get("q") ?? "");
  const [search, setSearch] = useState<Search>({ status: "idle", books: [] });
  const [chain, setChain] = useState<{ status: "idle" | "loading" | "ready" | "error"; data?: TraceChain; error?: unknown }>({ status: "idle" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!bookId) { setChain({ status: "idle" }); return; }
    let alive = true;
    setChain((previous) => ({ ...previous, status: "loading" }));
    fetchTrace(bookId, loanId)
      .then((data) => { if (alive) setChain({ status: "ready", data }); })
      .catch((error) => { if (alive) setChain({ status: "error", error }); });
    return () => { alive = false; };
  }, [bookId, loanId, nonce]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const query = text.trim();
    if (!query) return;
    setSearch({ status: "loading", books: [] });
    try {
      if (LOAN_ID.test(query)) {
        const loan = await findLoan(query);
        if (!loan) { setSearch({ status: "ready", books: [], missing: query }); return; }
        setSearch({ status: "idle", books: [] });
        setParams({ book: loan.book_id, loan: loan.id });
        return;
      }
      const books = await searchBooks(query);
      if (books.length === 1) {
        setSearch({ status: "idle", books: [] });
        setParams({ book: books[0]!.id });
        return;
      }
      setSearch({ status: "ready", books, missing: books.length ? undefined : query });
    } catch (error) {
      setSearch({ status: "error", books: [], error });
    }
  }

  const pick = (book: BookRow) => {
    setSearch({ status: "idle", books: [] });
    setParams({ book: book.id });
  };

  return (
    <>
      <PageHeading eyebrow="QUALITY / TRACEABILITY" title={t("admin.nav.trace")} subtitle={t("admin.trace.subtitle")} />

      <form className="admin-trace-search" role="search" onSubmit={onSubmit}>
        <label htmlFor="trace-q">{t("admin.trace.searchLabel")}</label>
        <div>
          <input id="trace-q" type="search" value={text} onChange={(event) => setText(event.target.value)} placeholder={t("admin.trace.placeholder")} autoComplete="off" />
          <Button type="submit" loading={search.status === "loading"}>{t("admin.trace.search")}</Button>
        </div>
        <p className="admin-muted">
          {t("admin.trace.examples")}{" "}
          {["loan-00009", "RFID-000010", "978-7"].map((example) => (
            <button key={example} type="button" className="admin-trace-example mono" onClick={() => setText(example)}>{example}</button>
          ))}
        </p>
      </form>

      {search.status === "error" ? <ErrorPanel error={search.error} onRetry={() => setSearch({ status: "idle", books: [] })} /> : null}
      {search.status === "ready" && search.missing ? (
        <div className="admin-empty"><EmptyState title={t("admin.trace.notFoundTitle")} body={t("admin.trace.notFoundBody", { q: search.missing })} /></div>
      ) : null}
      {search.status === "ready" && search.books.length ? (
        <section className="admin-trace-results" aria-label={t("admin.trace.results")}>
          <h2>{t("admin.trace.resultsCount", { count: search.books.length })}</h2>
          <StaggerList as="ul" className="admin-trace-result-list">
            {search.books.map((book) => (
              <li key={book.id}>
                <button type="button" className="admin-trace-result" onClick={() => pick(book)}>
                  <i aria-hidden="true" style={{ background: book.cover_color || undefined }} />
                  <span>
                    <code>{book.call_number ?? book.isbn}</code>
                    <b>{book.title}</b>
                    <small>{book.author} · <span className="mono">{book.rfid_tag}</span></small>
                  </span>
                  <BookBadge status={book.status} />
                </button>
              </li>
            ))}
          </StaggerList>
        </section>
      ) : null}

      {chain.status === "idle" && search.status !== "ready" ? (
        <div className="admin-empty"><EmptyState title={t("admin.trace.idleTitle")} body={t("admin.trace.idleBody")} /></div>
      ) : null}
      {chain.status === "loading" && !chain.data ? <div className="admin-trace-chain is-loading"><Skeleton lines={8} /></div> : null}
      {chain.status === "error" ? (
        chain.error instanceof TraceNotFound
          ? <div className="admin-empty"><EmptyState title={t("admin.trace.notFoundTitle")} body={t("admin.trace.notFoundBody", { q: chain.error.id })} /></div>
          : <ErrorPanel error={chain.error} onRetry={() => setNonce((value) => value + 1)} />
      ) : null}
      {chain.data && chain.status !== "error" ? (
        <Chain chain={chain.data} busy={chain.status === "loading"} onLoan={(id) => setParams({ book: chain.data!.book.id, loan: id })} />
      ) : null}
    </>
  );
}

function Step({ index, label, code, title, children, tone = "default" }: { index: number; label: string; code?: string; title: ReactNode; children?: ReactNode; tone?: "default" | "muted" | "alert" }) {
  return (
    <li className={`admin-trace-step is-${tone}`}>
      <span className="admin-trace-plate mono" aria-hidden="true">{String(index).padStart(2, "0")}</span>
      <article className="admin-trace-card">
        <i aria-hidden="true" />
        <div>
          <header>
            <span className="mono">{label}</span>
            {code ? <code>{code}</code> : null}
          </header>
          <h3>{title}</h3>
          {children}
        </div>
      </article>
    </li>
  );
}

function Chain({ chain, busy, onLoan }: { chain: TraceChain; busy: boolean; onLoan: (id: string) => void }) {
  const { t } = useTranslation();
  const { branchName } = useAdmin();
  const { book, loan, reader, device } = chain;
  const clipAlert = chain.alerts.find((alert) => alert.related_clip_id);

  return (
    <section className={busy ? "admin-trace is-refreshing" : "admin-trace"} aria-label={t("admin.trace.chainLabel", { title: book.title })} aria-busy={busy || undefined}>
      {chain.simulated ? <p className="admin-insight-note" role="note">{t("admin.trace.assembled")}</p> : null}
      <ol className="admin-trace-chain">
        <Step index={1} label={t("admin.trace.step.book")} code={book.call_number ?? book.isbn} title={book.title}>
          <dl className="admin-trace-dl">
            <dt>{t("catalog.author")}</dt><dd>{book.author || "—"}</dd>
            <dt>ISBN</dt><dd className="mono">{book.isbn}</dd>
            <dt>{t("admin.branch")}</dt><dd>{branchName(book.branch_id)}</dd>
            <dt>{t("catalog.location")}</dt><dd className="mono">{book.shelf_location || "—"}</dd>
            <dt>{t("catalog.status")}</dt><dd><BookBadge status={book.status} /></dd>
          </dl>
          <Link className="admin-trace-link" to={`/admin/books?q=${encodeURIComponent(book.isbn)}`}>{t("admin.trace.openBook")} →</Link>
        </Step>

        <Step index={2} label={t("admin.trace.step.rfid")} code={book.id} title={<span className="mono admin-trace-tag">{book.rfid_tag || "—"}</span>}>
          <p className="admin-trace-text">{t("admin.trace.rfidBound", { id: book.id })}</p>
          <p className="admin-trace-text admin-muted">{t("admin.trace.rfidGate")}</p>
        </Step>

        {loan ? (
          <>
            <Step index={3} label={t("admin.trace.step.loan")} code={loan.id} title={reader ? reader.display_name : loan.user_id}>
              {chain.loans.length > 1 ? (
                <label className="admin-trace-loan-pick">
                  <span>{t("admin.trace.loanPick", { count: chain.loans.length })}</span>
                  <select value={loan.id} onChange={(event) => onLoan(event.target.value)}>
                    {chain.loans.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.borrowed_at.slice(0, 10)} · {t(`admin.loanStatus.${item.status}`)}</option>)}
                  </select>
                </label>
              ) : null}
              <dl className="admin-trace-dl">
                <dt>{t("admin.trace.reader")}</dt><dd><span className="mono">{reader?.card_no ?? loan.user_id}</span></dd>
                <dt>{t("admin.trace.borrowed")}</dt><dd className="mono">{stamp(loan.borrowed_at)}</dd>
                <dt>{t("admin.trace.due")}</dt><dd className="mono">{stamp(loan.due_at)}</dd>
                <dt>{t("admin.trace.returned")}</dt><dd className="mono">{stamp(loan.returned_at)}</dd>
                <dt>{t("admin.trace.renewals")}</dt><dd className="mono">{loan.renew_count}</dd>
                <dt>{t("catalog.status")}</dt><dd><LoanBadge status={loan.status} /></dd>
              </dl>
            </Step>

            <Step index={4} label={t("admin.trace.step.device")} code={device?.id ?? loan.device_id ?? undefined} title={device ? device.name : t("admin.trace.deviceUnknown")}>
              {device ? (
                <p className="admin-trace-text">
                  {t(`admin.deviceKind.${device.kind}`, { defaultValue: device.kind })} · {branchName(device.branch_id)} · <span className="mono">{device.protocol}://{device.address}</span>
                </p>
              ) : null}
              <ol className="admin-trace-events">
                {chain.deviceEvents.map((event, index) => <DeviceEvent key={`${event.kind}-${index}`} event={event} />)}
              </ol>
            </Step>

            <Step index={5} label={t("admin.trace.step.clip")} code={clipAlert?.related_clip_id ?? undefined} title={clipAlert ? t("admin.trace.clipFrom", { alert: clipAlert.id }) : t("admin.trace.noClip")} tone={clipAlert ? "default" : "muted"}>
              {clipAlert ? <ClipPlayer alert={clipAlert} device={device ?? undefined} /> : <p className="admin-trace-text admin-muted">{t("admin.trace.noClipBody")}</p>}
            </Step>

            <Step index={6} label={t("admin.trace.step.alerts")} code={String(chain.alerts.length)} title={chain.alerts.length ? t("admin.trace.alertCount", { count: chain.alerts.length }) : t("admin.trace.noAlerts")} tone={chain.alerts.some((alert) => alert.status !== "resolved") ? "alert" : chain.alerts.length ? "default" : "muted"}>
              {chain.alerts.length ? (
                <ul className="admin-trace-alerts">
                  {chain.alerts.map((alert) => (
                    <li key={alert.id}>
                      <StatusBadge tone={alert.severity === "critical" ? "danger" : alert.severity === "warning" ? "warn" : "info"} label={t(`admin.severity.${alert.severity}`)} />
                      <span>
                        <b>{alert.message}</b>
                        <small className="mono">{alert.id} · {stamp(alert.created_at)} · {t(`admin.alertStatus.${alert.status}`)} · {t(`admin.trace.link.${alert.link}`)}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <p className="admin-trace-text admin-muted">{t("admin.trace.noAlertsBody")}</p>}
              {chain.alerts.length ? <Link className="admin-trace-link" to="/admin/alerts">{t("admin.alerts.viewAll")} →</Link> : null}
            </Step>
          </>
        ) : (
          <Step index={3} label={t("admin.trace.step.loan")} title={t("admin.trace.noLoans")} tone="muted">
            <p className="admin-trace-text admin-muted">{t("admin.trace.noLoansBody")}</p>
          </Step>
        )}
      </ol>
    </section>
  );
}

function DeviceEvent({ event }: { event: TraceDeviceEvent }) {
  const { t } = useTranslation();
  return (
    <li className={`is-${event.kind}`}>
      <time className="mono" dateTime={event.at}>{event.approximate ? "≈ " : ""}{stamp(event.at)}</time>
      <span>
        {t(`admin.trace.event.${event.kind}`)}
        {event.detail ? <> · {event.detail}</> : null}
        {event.deviceId ? <> · <span className="mono">{event.deviceId}</span></> : null}
      </span>
      {event.derived ? <small>{t("admin.trace.derived")}</small> : null}
    </li>
  );
}
