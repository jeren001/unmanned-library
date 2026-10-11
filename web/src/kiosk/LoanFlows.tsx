import type { ReactNode } from "react";
import { Button, CatalogCard, EmptyState, StatusBadge } from "../shared/components";
import { CheckIcon } from "../shared/icons";
import { CountUp, StaggerList } from "../shared/motion";
import { parseShelfLocation, ShelfRouteMap } from "../shared/ShelfRouteMap";
import type { Book, KioskResult, Loan } from "./kioskState";
import { bookStatusOf, callNumberOf, daysLeft, ErrorCard, formatDate, formatFine, overdueDays } from "./kioskUi";
import "./loans.css";

/*
 * Restyled Return, Renew, Reserve and My loans (reference: docs/reference/library-ux-motion.html, section 2).
 * Logic stays in KioskPage; these components render state and report clicks.
 */

const DUE_SOON_DAYS = 7;

function titleOf(loan: Loan) {
  return loan.book?.title ?? `Book ${loan.book_id}`;
}

/** Due state badge shared by every loan list. */
function DueBadge({ loan }: { loan: Loan }) {
  const late = overdueDays(loan);
  if (loan.status === "overdue" || late > 0) return <StatusBadge status="overdue" label={`逾期 ${late} 天 / ${late} d overdue`} />;
  const left = daysLeft(loan);
  if (left <= 0) return <StatusBadge status="borrowed" label="今天到期 / Due today" />;
  if (left <= DUE_SOON_DAYS) return <StatusBadge status="borrowed" label={`${left} 天后到期 / Due in ${left} d`} />;
  return <StatusBadge tone="ok" label={`应还 ${formatDate(loan.due_at)} / Due`} />;
}

function LoanRow({ loan, detail, note, action, className = "" }: { loan: Loan; detail: ReactNode; note?: ReactNode; action?: ReactNode; className?: string }) {
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

function Empty({ zh, en }: { zh: string; en: string }) {
  return <div className="kiosk-flow-empty"><EmptyState title={zh} body={en} /></div>;
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
  return (
    <div className="kiosk-flow kiosk-loans-flow">
      <div className="kiosk-return-scan">
        <div className="kiosk-return-pad" aria-hidden="true"><span /><span /><b>RFID</b></div>
        <div>
          <h2>把要归还的图书放到托盘上</h2>
          <p>Place books to return · 也可手动输入 RFID / ISBN</p>
          <div className="kiosk-manual-row">
            <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onManualReturn(); }} placeholder="RFID-000001 / ISBN" aria-label="RFID / ISBN" />
            <button onClick={onManualReturn}>查找 / Find</button>
          </div>
        </div>
      </div>
      {error ? <ErrorCard title="无法归还 / Cannot return" message={error} /> : null}
      <h2 className="kiosk-subheading">在借图书 / Your loans</h2>
      {loans.length ? (
        <StaggerList className="kiosk-loan-rows">
          {loans.map((loan) => {
            const late = overdueDays(loan);
            return (
              <LoanRow
                key={loan.id}
                loan={loan}
                className={late ? "is-overdue" : ""}
                detail={<>{loan.book?.author ?? "Library item"} · 应还 {formatDate(loan.due_at)} · <span className="mono">{loan.book?.shelf_location ?? "--"}</span></>}
                note={late ? <em>逾期费 / Fine {formatFine(late * finePerDayCents)}</em> : null}
                action={<button className="kiosk-row-action" onClick={() => onReturn(loan)} disabled={busy}>归还 / Return</button>}
              />
            );
          })}
        </StaggerList>
      ) : <Empty zh="暂无可归还图书" en="No active loans" />}
    </div>
  );
}

/** Return result: shelf route map built from the book's location, plus the fine when overdue. */
export function ReturnResult({ result, onDone }: { result: KioskResult; onDone: () => void }) {
  const item = result.items?.[0];
  const place = parseShelfLocation(item?.shelf);
  return (
    <section className="kiosk-result kiosk-return-result">
      <div className="kiosk-return-map">
        <ShelfRouteMap location={item?.shelf} />
      </div>
      <div className="kiosk-return-summary">
        <div className={`kiosk-result-mark ${result.kind}`}><CheckIcon /></div>
        <h1>{result.title}</h1>
        {item ? <p className="kiosk-return-book">《{item.title}》</p> : null}
        <p className="kiosk-return-where">
          {place
            ? <>请放回 <b>{place.zone} 区 · {place.shelf} 号架</b><small>Zone {place.zone}, shelf {place.shelf} · 跟着红点走 / Follow the red dot</small></>
            : <>{result.detail}</>}
        </p>
        {item?.fineCents ? (
          <div className="kiosk-return-fine">
            <StatusBadge status="overdue" label={`逾期 ${item.overdueDays ?? 0} 天 / ${item.overdueDays ?? 0} d overdue`} />
            <span>逾期费 / Fine</span>
            <b>{formatFine(item.fineCents)}</b>
            <small>请在服务台或读者账户中缴纳 / Pay at the desk or in your account</small>
          </div>
        ) : null}
        {result.kind === "offline" ? <p className="kiosk-return-offline">网络恢复后自动提交 / Will sync when online</p> : null}
        <button className="kiosk-start" onClick={onDone}><span>返回首页</span><small>Back to home</small><span>→</span></button>
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
  return (
    <div className="kiosk-flow kiosk-loans-flow">
      <p className="kiosk-section-intro">勾选要续借的图书 / Check books to renew · 每本最多续借 {maxRenewals} 次 / up to {maxRenewals} times</p>
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
                    <span>当前 {formatDate(loan.due_at)}</span>
                    <span aria-hidden="true">→</span>
                    <b>{blocked ? "--" : newDue}</b>
                    <small>续借 {loan.renew_count}/{maxRenewals}</small>
                  </span>
                  {blocked ? <em>不能续借：已达续借上限 {maxRenewals} 次，请按期归还 / Renewal limit reached — please return it on time</em> : null}
                </div>
                <DueBadge loan={loan} />
              </label>
            );
          })}
        </StaggerList>
      ) : <Empty zh="暂无可续借图书" en="No active loans" />}
      {error ? <ErrorCard title="无法续借 / Cannot renew" message={error} /> : null}
      <div className="kiosk-flow-actions">
        <button onClick={onBack}>取消 / Cancel</button>
        <span className="kiosk-renew-count">已选 <b>{selected.length}</b> 本 / selected</span>
        <Button loading={busy} onClick={onSubmit}>确认续借 / Renew selected</Button>
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
  const reservable = results.filter((book) => book.status === "borrowed");
  return (
    <div className="kiosk-flow kiosk-loans-flow">
      <div className="kiosk-search-row">
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} placeholder="书名、拼音或 ISBN / Title, pinyin or ISBN" aria-label="书名、拼音或 ISBN / Title, pinyin or ISBN" />
        <button onClick={onSearch}>搜索 / Search</button>
      </div>
      {error ? <ErrorCard title="无法预约 / Cannot reserve" message={error} /> : null}
      {reservable.length ? (
        <StaggerList className="kiosk-reserve-grid" replayKey={results}>
          {reservable.map((book) => {
            const code = callNumberOf(book);
            return (
              <CatalogCard key={book.id} callNumber={code.value} callNumberLabel={code.label} title={`《${book.title}》`} author={book.author} location={book.shelf_location} status={bookStatusOf(book)}>
                <div className="kiosk-reserve-action">
                  <small>已借出，可预约 / On loan — reserve it</small>
                  <Button disabled={busy} onClick={() => onReserve(book)}>预约 / Reserve</Button>
                </div>
              </CatalogCard>
            );
          })}
        </StaggerList>
      ) : results.length ? (
        <Empty zh="搜索到的图书都在架上，可直接借阅" en="All matching books are on the shelf — borrow them directly" />
      ) : (
        <Empty zh="输入关键词开始搜索" en="Search by title or ISBN" />
      )}
    </div>
  );
}

/* ---------------- My loans ---------------- */

export function LoansFlow({ loans, finePerDayCents }: { loans: Loan[]; finePerDayCents: number }) {
  const sorted = [...loans].sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
  const overdue = loans.filter((loan) => loan.status === "overdue" || overdueDays(loan) > 0).length;
  const dueSoon = loans.filter((loan) => !(loan.status === "overdue" || overdueDays(loan) > 0) && daysLeft(loan) <= DUE_SOON_DAYS).length;

  return (
    <div className="kiosk-flow kiosk-loans-flow">
      <div className="kiosk-loans-summary">
        <div><span>在借 / On loan</span><b><CountUp value={loans.length} duration={700} /></b></div>
        <div className={dueSoon ? "is-warn" : ""}><span>即将到期 / Due soon</span><b><CountUp value={dueSoon} duration={700} /></b></div>
        <div className={overdue ? "is-danger" : ""}><span>逾期 / Overdue</span><b><CountUp value={overdue} duration={700} /></b></div>
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
                detail={<>{loan.book?.author ?? ""}{loan.book?.author ? " · " : ""}应还 {formatDate(loan.due_at)} · 续借 {loan.renew_count} 次</>}
                note={late ? <em>预计逾期费 / Fine so far {formatFine(late * finePerDayCents)}</em> : soon ? <em className="is-soon">请尽快归还或续借 / Return or renew soon</em> : null}
              />
            );
          })}
        </StaggerList>
      ) : <Empty zh="暂无借阅记录" en="No active loans" />}
    </div>
  );
}
