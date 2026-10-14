import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button, CatalogCard, StatusBadge, Stepper } from "../shared/components";
import { AlertIcon, CheckIcon, CloseIcon } from "../shared/icons";
import { formatDate as formatLocalDate, formatNumber } from "../shared/i18n";
import { callNumberOf, ErrorCard, formatDate, useKioskText } from "./kioskUi";
import { animate, BookmarkRibbon, CatalogDrawer, CountUp, PageTurn, prefersReducedMotion, StaggerList } from "../shared/motion";
import type { Book, KioskResult } from "./kioskState";
import "./borrow.css";

/*
 * Borrow flow visuals (reference: docs/reference/library-ux-motion.html, section 2).
 * Logic stays in KioskPage; these components only render state and report clicks.
 */

const STEPS = ["put", "confirm", "receipt"];
const MIN_READ_MS = 900;

export function BorrowStepper({ step }: { step: 0 | 1 | 2 }) {
  const { t } = useTranslation();
  return <div className="kiosk-borrow-stepper"><Stepper steps={STEPS.map((key) => t(`kiosk.borrow.step.${key}`))} current={step} /></div>;
}

type BorrowFlowProps = {
  books: Book[];
  scannedBookIds: string[];
  step: "scan" | "confirm" | "receipt";
  input: string;
  setInput: (value: string) => void;
  error: string;
  onAdd: () => Promise<void>;
  onRemove: (id: string) => void;
  onNext: () => void;
  onConfirm: () => void;
  onBack: () => void;
  busy: boolean;
  loanDays: number;
  maxLoans: number;
  activeLoanCount: number;
};

export function BorrowFlow(props: BorrowFlowProps) {
  const { t } = useTranslation();
  const text = useKioskText();
  const { books, scannedBookIds, step, error, onNext, onConfirm, onBack, busy, loanDays, maxLoans, activeLoanCount } = props;
  const picked = scannedBookIds.map((id) => books.find((book) => book.id === id)).filter((book): book is Book => Boolean(book));
  const available = picked.filter((book) => book.status === "on_shelf");
  const overLimit = activeLoanCount + available.length > maxLoans;

  return (
    <div className="kiosk-flow kiosk-borrow">
      <BorrowStepper step={step === "scan" ? 0 : 1} />
      <PageTurn turnKey={step}>
        {step === "scan" ? (
          <ScanStep {...props} picked={picked} />
        ) : (
          <ConfirmStep books={available} loanDays={loanDays} maxLoans={maxLoans} activeLoanCount={activeLoanCount} />
        )}
      </PageTurn>
      <LoanLimit maxLoans={maxLoans} activeLoanCount={activeLoanCount} picking={available.length} overLimit={overLimit} />
      {error ? <ErrorCard title={t("kiosk.borrow.cannot")} message={text(error)} /> : null}
      <div className="kiosk-flow-actions">
        <button onClick={onBack}>{t("kiosk.flow.cancel")}</button>
        {step === "scan"
          ? <Button onClick={onNext} disabled={!available.length}>{t("kiosk.borrow.review")}</Button>
          : <Button loading={busy} onClick={onConfirm}>{t("kiosk.borrow.confirm")}</Button>}
      </div>
    </div>
  );
}

function ScanStep({ picked, input, setInput, onAdd, onRemove }: BorrowFlowProps & { picked: Book[] }) {
  const { t } = useTranslation();
  const [reading, setReading] = useState(false);
  const [landed, setLanded] = useState(0);
  const count = useRef(picked.length);
  const last = picked[picked.length - 1];

  // Any newly placed book (manual entry or the dev drawer) "lands" on the tray.
  useEffect(() => {
    if (picked.length > count.current) setLanded((value) => value + 1);
    count.current = picked.length;
  }, [picked.length]);

  async function read() {
    if (reading || !input.trim()) return;
    setReading(true);
    const minimum = new Promise((resolve) => window.setTimeout(resolve, prefersReducedMotion() ? 0 : MIN_READ_MS));
    await Promise.all([onAdd(), minimum]);
    setReading(false);
  }

  return (
    <>
      <div className={`kiosk-borrow-tray ${reading ? "is-reading" : ""}`}>
        <div className="kiosk-borrow-tray-bed" aria-hidden="true">
          <span className="kiosk-borrow-ring" />
          <span className="kiosk-borrow-ring" />
          <span className="kiosk-borrow-ring" />
          <TrayBook key={landed} book={last} />
          <span className="kiosk-borrow-scanline" />
        </div>
        <div className="kiosk-borrow-tray-copy">
          <h2>{t("kiosk.borrow.trayTitle")}</h2>
          <p>{t("kiosk.borrow.trayHint")}</p>
          <div className="kiosk-manual-row">
            <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void read(); }} placeholder={t("kiosk.flow.tagPlaceholder")} aria-label={t("kiosk.flow.tagLabel")} />
            <button onClick={() => void read()} disabled={reading}>{t("kiosk.borrow.add")}</button>
          </div>
          <p className="kiosk-borrow-reading" role="status">{reading ? t("kiosk.borrow.reading") : ""}</p>
        </div>
      </div>
      <StaggerList className="kiosk-book-list" replayKey={picked.length} step={40}>
        {picked.slice(-5).map((book) => (
          book.status === "on_shelf"
            ? <PickedBook key={book.id} book={book} onRemove={() => onRemove(book.id)} />
            : <UnavailableBook key={book.id} book={book} onRemove={() => onRemove(book.id)} />
        ))}
      </StaggerList>
    </>
  );
}

function TrayBook({ book }: { book?: Book }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!book) return;
    const animation = animate(ref.current, [{ transform: "translateY(-26px)", opacity: 0 }, { transform: "translateY(-8px)", opacity: 1, offset: 0.55 }, { transform: "none", opacity: 1 }], { duration: 600, easing: "ease-in-out" });
    return () => animation?.cancel();
  }, [book]);
  return (
    <div ref={ref} className={`kiosk-borrow-book ${book ? "is-placed" : ""}`} style={book ? { background: book.cover_color } : undefined}>
      <span>{book ? book.title.slice(0, 6) : "RFID"}</span>
    </div>
  );
}

function PickedBook({ book, onRemove }: { book: Book; onRemove: () => void }) {
  const { t } = useTranslation();
  const code = callNumberOf(book);
  return (
    <article className="kiosk-book-card">
      <span className="kiosk-spine" style={{ background: book.cover_color }} />
      <div><strong>{book.title}</strong><span>{book.author} · {book.shelf_location}</span><code>{code.value}</code></div>
      <button onClick={onRemove} aria-label={t("kiosk.borrow.remove", { title: book.title })}><CloseIcon /></button>
    </article>
  );
}

function UnavailableBook({ book, onRemove }: { book: Book; onRemove: () => void }) {
  const { t } = useTranslation();
  const borrowed = book.status === "borrowed";
  return (
    <article className="kiosk-book-card is-unavailable">
      <span className="kiosk-spine" />
      <div>
        <strong>{book.title}</strong>
        <span>{t(borrowed ? "kiosk.borrow.alreadyOnLoan" : "kiosk.borrow.notForLoan")}</span>
        <StatusBadge status={borrowed ? "borrowed" : "repair"} label={t(borrowed ? "kiosk.borrow.badgeOnLoan" : "kiosk.borrow.badgeUnavailable")} />
      </div>
      <button onClick={onRemove} aria-label={t("kiosk.borrow.remove", { title: book.title })}><CloseIcon /></button>
    </article>
  );
}

function ConfirmStep({ books, loanDays, maxLoans, activeLoanCount }: { books: Book[]; loanDays: number; maxLoans: number; activeLoanCount: number }) {
  const { t } = useTranslation();
  const due = formatDate(new Date(Date.now() + loanDays * 86400000));
  return (
    <>
      <h2 className="kiosk-subheading">{t("kiosk.borrow.confirmTitle")}</h2>
      <CatalogDrawer label={books[0]?.category ?? t("kiosk.borrow.drawer")} className="kiosk-borrow-drawer">
        <div className="kiosk-borrow-cards">
          {books.map((book) => {
            const code = callNumberOf(book);
            return (
              <CatalogCard key={book.id} callNumber={code.value} callNumberLabel={code.label} title={t("kiosk.home.bookTitle", { title: book.title })} author={book.author} location={book.shelf_location}>
                <dl className="kiosk-borrow-due">
                  <dt>{t("kiosk.borrow.due")}</dt><dd>{t("kiosk.borrow.dueIn", { date: due, days: formatNumber(loanDays) })}</dd>
                </dl>
                <p className="kiosk-borrow-limit-note">{t("kiosk.borrow.limitNote", { max: formatNumber(maxLoans), active: formatNumber(activeLoanCount) })}</p>
              </CatalogCard>
            );
          })}
        </div>
      </CatalogDrawer>
    </>
  );
}

function LoanLimit({ maxLoans, activeLoanCount, picking, overLimit }: { maxLoans: number; activeLoanCount: number; picking: number; overLimit: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`kiosk-borrow-limit ${overLimit ? "is-over" : ""}`}>
      <span><Trans i18nKey="kiosk.borrow.limit" values={{ n: formatNumber(maxLoans) }} components={{ b: <b /> }} /></span>
      <span><Trans i18nKey="kiosk.borrow.onLoan" values={{ n: formatNumber(activeLoanCount) }} components={{ b: <b /> }} /></span>
      <span><Trans i18nKey="kiosk.borrow.thisTime" values={{ n: formatNumber(picking) }} components={{ b: <b /> }} /></span>
      {overLimit ? <strong><AlertIcon />{t("kiosk.borrow.overLimit")}</strong> : null}
    </div>
  );
}

/** Step 3: the receipt prints, gets stamped, a ribbon drops, then "My loans" rolls up. */
export function BorrowReceipt({ result, loanCount, onDone }: { result: KioskResult; loanCount: number; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const text = useKioskText();
  const slipRef = useRef<HTMLDivElement>(null);
  const stampRef = useRef<HTMLSpanElement>(null);
  const [showCount, setShowCount] = useState(prefersReducedMotion);
  const offline = result.kind === "offline";
  const printedAt = useRef(new Date()).current;

  useLayoutEffect(() => {
    const animations = [
      animate(slipRef.current, [{ transform: "translateY(-100%)" }, { transform: "none" }], { duration: 1600, easing: "steps(14, end)", fill: "backwards" }),
      animate(stampRef.current, [{ opacity: 0, transform: "rotate(-14deg) scale(2.2)" }, { opacity: 0.9, transform: "rotate(-14deg) scale(1)" }], { duration: 400, delay: 1500, easing: "cubic-bezier(.2, .9, .3, 1.3)", fill: "backwards" })
    ];
    const timer = window.setTimeout(() => setShowCount(true), prefersReducedMotion() ? 0 : 2100);
    return () => {
      window.clearTimeout(timer);
      animations.forEach((animation) => animation?.cancel());
    };
  }, []);

  return (
    <section className="kiosk-result kiosk-borrow-result">
      <BookmarkRibbon delay={1200} className="kiosk-borrow-ribbon" />
      <BorrowStepper step={2} />
      <div className="kiosk-borrow-receipt">
        <div className="kiosk-borrow-printer">
          <span className="kiosk-borrow-printer-mouth" aria-hidden="true" />
          <div className="kiosk-borrow-paper">
            <div ref={slipRef} className="kiosk-borrow-slip">
              <header>
                <b>{t("kiosk.borrow.receipt.title")}</b>
                <span className="mono">{t("kiosk.borrow.receipt.printed", { date: formatLocalDate(printedAt, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) })}</span>
              </header>
              <ul>
                {(result.items ?? []).map((item) => (
                  <li key={item.title}>
                    <span>{t("kiosk.home.bookTitle", { title: item.title })}</span>
                    <span className="mono">{t("kiosk.flow.dueOn", { date: item.dueAt ? formatDate(item.dueAt) : "--" })}</span>
                  </li>
                ))}
              </ul>
              <footer>{t(offline ? "kiosk.flow.willSync" : "kiosk.borrow.receipt.footer")}</footer>
              <span ref={stampRef} className={`kiosk-borrow-stamp ${offline ? "is-queued" : ""}`}>{t(offline ? "kiosk.borrow.receipt.stampQueued" : "kiosk.borrow.receipt.stampDone")}</span>
            </div>
          </div>
        </div>

        <div className="kiosk-borrow-summary">
          <div className={`kiosk-result-mark ${result.kind}`}><CheckIcon /></div>
          <h1>{text(result.title, result.values)}</h1>
          <p>{text(result.detail, result.values)}</p>
          <div className={`kiosk-borrow-count ${showCount ? "is-on" : ""}`} aria-live="polite">
            <span>{t("kiosk.screen.loans")}</span>
            {showCount ? <b><CountUp value={loanCount} duration={900} locale={i18n.language} /></b> : <b>&nbsp;</b>}
          </div>
          <button className="kiosk-start" onClick={onDone}><span>{t("kiosk.flow.backHome")}</span><span>→</span></button>
        </div>
      </div>
    </section>
  );
}
