import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, CatalogCard, EmptyState, StatusBadge } from "../shared/components";
import { CheckIcon } from "../shared/icons";
import { formatNumber } from "../shared/i18n";
import { CountUp, StaggerList } from "../shared/motion";
import { parseShelfLocation, ShelfRouteMap } from "../shared/ShelfRouteMap";
import type { Book, KioskResult, Loan } from "./kioskState";
import { bookStatusOf, callNumberOf, daysLeft, ErrorCard, formatDate, formatFine, overdueDays, useKioskText } from "./kioskUi";
import "./loans.css";

/*
 * Restyled Return, Renew, Reserve and My loans (reference: docs/reference/library-ux-motion.html, section 2).
 * Logic stays in KioskPage; these components render state and report clicks.
 */

const DUE_SOON_DAYS = 7;

function useTitleOf() {
  const { t } = useTranslation();
  return (loan: Loan) => loan.book?.title ?? t("kiosk.flow.unknownBook", { id: loan.book_id });
}

/** Due state badge shared by every loan list. */
function DueBadge({ loan }: { loan: Loan }) {
  const { t } = useTranslation();
  const late = overdueDays(loan);
  if (loan.status === "overdue" || late > 0) return <StatusBadge status="overdue" label={t("kiosk.flow.overdueDays", { days: formatNumber(late) })} />;
  const left = daysLeft(loan);
  if (left <= 0) return <StatusBadge status="borrowed" label={t("kiosk.home.due.today")} />;
  if (left <= DUE_SOON_DAYS) return <StatusBadge status="borrowed" label={t("kiosk.flow.dueInDays", { days: formatNumber(left) })} />;
  return <StatusBadge tone="ok" label={t("kiosk.flow.dueOn", { date: formatDate(loan.due_at) })} />;
}

function LoanRow({ loan, detail, note, action, className = "" }: { loan: Loan; detail: ReactNode; note?: ReactNode; action?: ReactNode; className?: string }) {
  const titleOf = useTitleOf();
  return (
    <article className={`kiosk-loan-row ${className}`}>
      <span className="kiosk-loan-row-spine" style={{ background: loan.book?.cover_color }} aria-hidden="true" />
      <div className="kiosk-loan-row-main">
        <strong>{titleOf(loan)}</strong>
        <span>{detail}</span>
        {note}
      </div>
      <DueBadge loan={loan} />
      {action}
    </article>
  );
}

function Empty({ name }: { name: string }) {
  const { t } = useTranslation();
  return <div className="kiosk-flow-empty"><EmptyState title={t(`kiosk.empty.${name}.title`)} body={t(`kiosk.empty.${name}.body`)} /></div>;
}

/* ---------------- Return ---------------- */

export function ReturnFlow({ loans, finePerDayCents, onReturn, onManualReturn, input, setInput, busy, error }: {
  loans: Loan[];
  finePerDayCents: number;
  onReturn: (loan: Loan) => void;
  onManualReturn: () => void;
  input: string;
  setInput: (value: string) => void;
  busy: boolean;
  error: string;
}) {
  const { t } = useTranslation();
  const text = useKioskText();
  return (
    <div className="kiosk-flow kiosk-loans-flow">
      <div className="kiosk-return-scan">
        <div className="kiosk-return-pad" aria-hidden="true"><span /><span /><b>RFID</b></div>
        <div>
          <h2>{t("kiosk.return.trayTitle")}</h2>
          <p>{t("kiosk.return.trayHint")}</p>
          <div className="kiosk-manual-row">
            <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onManualReturn(); }} placeholder={t("kiosk.flow.tagPlaceholder")} aria-label={t("kiosk.flow.tagLabel")} />
            <button onClick={onManualReturn}>{t("kiosk.return.find")}</button>
          </div>
        </div>
      </div>
      {error ? <ErrorCard title={t("kiosk.return.cannot")} message={text(error)} /> : null}
      <h2 className="kiosk-subheading">{t("kiosk.return.yourLoans")}</h2>
      {loans.length ? (
        <StaggerList className="kiosk-loan-rows">
          {loans.map((loan) => {
            const late = overdueDays(loan);
            return (
              <LoanRow
                key={loan.id}
                loan={loan}
                className={late ? "is-overdue" : ""}
                detail={<>{loan.book?.author ?? t("kiosk.flow.libraryItem")} · {t("kiosk.flow.dueOn", { date: formatDate(loan.due_at) })} · <span className="mono">{loan.book?.shelf_location ?? "--"}</span></>}
                note={late ? <em>{t("kiosk.return.fine", { fine: formatFine(late * finePerDayCents) })}</em> : null}
                action={<button className="kiosk-row-action" onClick={() => onReturn(loan)} disabled={busy}>{t("kiosk.return.action")}</button>}
              />
            );
          })}
        </StaggerList>
      ) : <Empty name="return" />}
    </div>
  );
}

/** Return result: shelf route map built from the book's location, plus the fine when overdue. */
export function ReturnResult({ result, onDone }: { result: KioskResult; onDone: () => void }) {
  const { t } = useTranslation();
  const text = useKioskText();
  const item = result.items?.[0];
  const place = parseShelfLocation(item?.shelf);
  return (
    <section className="kiosk-result kiosk-return-result">
      <div className="kiosk-return-map">
        <ShelfRouteMap location={item?.shelf} />
      </div>
      <div className="kiosk-return-summary">
        <div className={`kiosk-result-mark ${result.kind}`}><CheckIcon /></div>
        <h1>{text(result.title, result.values)}</h1>
        {item ? <p className="kiosk-return-book">{t("kiosk.home.bookTitle", { title: item.title })}</p> : null}
        <p className="kiosk-return-where">
          {place
            ? <><Trans i18nKey="kiosk.return.putBack" values={{ zone: place.zone, shelf: place.shelf }} components={{ b: <b /> }} /><small>{t("kiosk.return.followDot")}</small></>
            : <>{text(result.detail, result.values)}</>}
        </p>
        {item?.fineCents ? (
          <div className="kiosk-return-fine">
            <StatusBadge status="overdue" label={t("kiosk.flow.overdueDays", { days: formatNumber(item.overdueDays ?? 0) })} />
            <span>{t("kiosk.return.fineLabel")}</span>
            <b>{formatFine(item.fineCents)}</b>
            <small>{t("kiosk.return.payHint")}</small>
          </div>
        ) : null}
        {result.kind === "offline" ? <p className="kiosk-return-offline">{t("kiosk.flow.willSync")}</p> : null}
        <button className="kiosk-start" onClick={onDone}><span>{t("kiosk.flow.backHome")}</span><span>→</span></button>
      </div>
    </section>
  );
}

/* ---------------- Renew ---------------- */

export function RenewFlow({ loans, selected, maxRenewals, loanDays, onSelect, onSubmit, onBack, busy, error }: {
  loans: Loan[];
  selected: string[];
  maxRenewals: number;
  loanDays: number;
  onSelect: (ids: string[]) => void;
  onSubmit: () => void;
  onBack: () => void;
  busy: boolean;
  error: string;
}) {
  const { t } = useTranslation();
  const text = useKioskText();
  const titleOf = useTitleOf();
  return (
    <div className="kiosk-flow kiosk-loans-flow">
      <p className="kiosk-section-intro">{t("kiosk.renew.intro", { max: formatNumber(maxRenewals) })}</p>
      {loans.length ? (
        <StaggerList className="kiosk-loan-rows">
          {loans.map((loan) => {
            const blocked = loan.renew_count >= maxRenewals;
            const checked = selected.includes(loan.id);
            const newDue = formatDate(new Date(new Date(loan.due_at).getTime() + loanDays * 86400000));
            return (
              <label key={loan.id} className={`kiosk-checkable kiosk-renew-row ${blocked ? "is-blocked" : ""} ${checked ? "is-checked" : ""}`}>
                <input type="checkbox" disabled={blocked} checked={checked} onChange={() => onSelect(checked ? selected.filter((id) => id !== loan.id) : [...selected, loan.id])} />
                <div className="kiosk-loan-row-main">
                  <strong>{titleOf(loan)}</strong>
                  <span className="kiosk-renew-dates">
                    <span>{t("kiosk.renew.current", { date: formatDate(loan.due_at) })}</span>
                    <span aria-hidden="true">→</span>
                    <b>{blocked ? "--" : newDue}</b>
                    <small>{t("kiosk.renew.count", { used: formatNumber(loan.renew_count), max: formatNumber(maxRenewals) })}</small>
                  </span>
                  {blocked ? <em>{t("kiosk.renew.blocked", { max: formatNumber(maxRenewals) })}</em> : null}
                </div>
                <DueBadge loan={loan} />
              </label>
            );
          })}
        </StaggerList>
      ) : <Empty name="renew" />}
      {error ? <ErrorCard title={t("kiosk.renew.cannot")} message={text(error)} /> : null}
      <div className="kiosk-flow-actions">
        <button onClick={onBack}>{t("kiosk.flow.cancel")}</button>
        <span className="kiosk-renew-count"><Trans i18nKey="kiosk.renew.selected" values={{ n: formatNumber(selected.length) }} components={{ b: <b /> }} /></span>
        <Button loading={busy} onClick={onSubmit}>{t("kiosk.renew.submit")}</Button>
      </div>
    </div>
  );
}

/* ---------------- Reserve ---------------- */

export function ReserveFlow({ query, setQuery, results, onSearch, onReserve, busy, error }: {
  query: string;
  setQuery: (value: string) => void;
  results: Book[];
  onSearch: () => void;
  onReserve: (book: Book) => void;
  busy: boolean;
  error: string;
}) {
  const { t } = useTranslation();
  const text = useKioskText();
  const reservable = results.filter((book) => book.status === "borrowed");
  return (
    <div className="kiosk-flow kiosk-loans-flow">
      <div className="kiosk-search-row">
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} placeholder={t("kiosk.reserve.placeholder")} aria-label={t("kiosk.reserve.placeholder")} />
        <button onClick={onSearch}>{t("kiosk.reserve.search")}</button>
      </div>
      {error ? <ErrorCard title={t("kiosk.reserve.cannot")} message={text(error)} /> : null}
      {reservable.length ? (
        <StaggerList className="kiosk-reserve-grid" replayKey={results}>
          {reservable.map((book) => {
            const code = callNumberOf(book);
            return (
              <CatalogCard key={book.id} callNumber={code.value} callNumberLabel={code.label} title={t("kiosk.home.bookTitle", { title: book.title })} author={book.author} location={book.shelf_location} status={bookStatusOf(book)}>
                <div className="kiosk-reserve-action">
                  <small>{t("kiosk.reserve.onLoan")}</small>
                  <Button disabled={busy} onClick={() => onReserve(book)}>{t("kiosk.reserve.action")}</Button>
                </div>
              </CatalogCard>
            );
          })}
        </StaggerList>
      ) : results.length ? (
        <Empty name="reserveOnShelf" />
      ) : (
        <Empty name="reserveStart" />
      )}
    </div>
  );
}

/* ---------------- My loans ---------------- */

export function LoansFlow({ loans, finePerDayCents }: { loans: Loan[]; finePerDayCents: number }) {
  const sorted = [...loans].sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
  const overdue = loans.filter((loan) => loan.status === "overdue" || overdueDays(loan) > 0).length;
  const dueSoon = loans.filter((loan) => !(loan.status === "overdue" || overdueDays(loan) > 0) && daysLeft(loan) <= DUE_SOON_DAYS).length;
  const { t, i18n } = useTranslation();

  return (
    <div className="kiosk-flow kiosk-loans-flow">
      <div className="kiosk-loans-summary">
        <div><span>{t("kiosk.loans.onLoan")}</span><b><CountUp value={loans.length} duration={700} locale={i18n.language} /></b></div>
        <div className={dueSoon ? "is-warn" : ""}><span>{t("kiosk.loans.dueSoon")}</span><b><CountUp value={dueSoon} duration={700} locale={i18n.language} /></b></div>
        <div className={overdue ? "is-danger" : ""}><span>{t("kiosk.loans.overdue")}</span><b><CountUp value={overdue} duration={700} locale={i18n.language} /></b></div>
      </div>
      {sorted.length ? (
        <StaggerList className="kiosk-loan-rows">
          {sorted.map((loan) => {
            const late = overdueDays(loan);
            const soon = !late && daysLeft(loan) <= DUE_SOON_DAYS;
            return (
              <LoanRow
                key={loan.id}
                loan={loan}
                className={late ? "is-overdue" : soon ? "is-soon" : ""}
                detail={<>{loan.book?.author ?? ""}{loan.book?.author ? " · " : ""}{t("kiosk.flow.dueOn", { date: formatDate(loan.due_at) })} · {t("kiosk.loans.renewed", { n: formatNumber(loan.renew_count) })}</>}
                note={late ? <em>{t("kiosk.loans.fineSoFar", { fine: formatFine(late * finePerDayCents) })}</em> : soon ? <em className="is-soon">{t("kiosk.loans.soonHint")}</em> : null}
              />
            );
          })}
        </StaggerList>
      ) : <Empty name="loans" />}
    </div>
  );
}
