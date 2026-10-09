import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, CatalogCard, StatusBadge, Stepper } from "../shared/components";
import { AlertIcon, CheckIcon, CloseIcon } from "../shared/icons";
import { callNumberOf, ErrorCard, formatDate } from "./kioskUi";
import { animate, BookmarkRibbon, CatalogDrawer, CountUp, PageTurn, prefersReducedMotion, StaggerList } from "../shared/motion";
import type { Book, KioskResult } from "./kioskState";
import "./borrow.css";

/*
 * Borrow flow visuals (reference: docs/reference/library-ux-motion.html, section 2).
 * Logic stays in KioskPage; these components only render state and report clicks.
 */

const STEPS = ["放书 / Put", "确认 / Confirm", "取小票 / Receipt"];
const MIN_READ_MS = 900;

export function BorrowStepper({ step }: { step: 0 | 1 | 2 }) {
  return <div className="kiosk-borrow-stepper"><Stepper steps={STEPS} current={step} /></div>;
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
      {error ? <ErrorCard title="无法借阅 / Cannot borrow" message={error} /> : null}
      <div className="kiosk-flow-actions">
        <button onClick={onBack}>取消 / Cancel</button>
        {step === "scan"
          ? <Button onClick={onNext} disabled={!available.length}>确认借阅 / Review</Button>
          : <Button loading={busy} onClick={onConfirm}>借阅并开闸 / Borrow & exit</Button>}
      </div>
    </div>
  );
}

function ScanStep({ picked, input, setInput, onAdd, onRemove }: BorrowFlowProps & { picked: Book[] }) {
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
          <h2>请将图书平放在感应区</h2>
          <p>Lay books flat on the tray · 一次可放多本 · 也可手动输入 RFID / ISBN</p>
          <div className="kiosk-manual-row">
            <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void read(); }} placeholder="RFID-000001 / ISBN" aria-label="RFID / ISBN" />
            <button onClick={() => void read()} disabled={reading}>添加 / Add</button>
          </div>
          <p className="kiosk-borrow-reading" role="status">{reading ? "正在读取标签… / Reading tag…" : ""}</p>
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
  const code = callNumberOf(book);
  return (
    <article className="kiosk-book-card">
      <span className="kiosk-spine" style={{ background: book.cover_color }} />
      <div><strong>{book.title}</strong><span>{book.author} · {book.shelf_location}</span><code>{code.value}</code></div>
      <button onClick={onRemove} aria-label={`Remove ${book.title}`}><CloseIcon /></button>
    </article>
  );
}

function UnavailableBook({ book, onRemove }: { book: Book; onRemove: () => void }) {
  const borrowed = book.status === "borrowed";
  return (
    <article className="kiosk-book-card is-unavailable">
      <span className="kiosk-spine" />
      <div>
        <strong>{book.title}</strong>
        <span>{borrowed ? "这本书已被借出，不能再次借阅 / Already on loan" : "这本书暂不可借 / Not available for loan"}</span>
        <StatusBadge status={borrowed ? "borrowed" : "repair"} label={borrowed ? "借出 / On loan" : "不可借 / Unavailable"} />
      </div>
      <button onClick={onRemove} aria-label={`Remove ${book.title}`}><CloseIcon /></button>
    </article>
  );
}

function ConfirmStep({ books, loanDays, maxLoans, activeLoanCount }: { books: Book[]; loanDays: number; maxLoans: number; activeLoanCount: number }) {
  const due = formatDate(new Date(Date.now() + loanDays * 86400000));
  return (
    <>
      <h2 className="kiosk-subheading">请确认以下借阅 / Confirm these books</h2>
      <CatalogDrawer label={books[0]?.category ?? "借阅 / LOAN"} className="kiosk-borrow-drawer">
        <div className="kiosk-borrow-cards">
          {books.map((book) => {
            const code = callNumberOf(book);
            return (
              <CatalogCard key={book.id} callNumber={code.value} callNumberLabel={code.label} title={`《${book.title}》`} author={book.author} location={book.shelf_location}>
                <dl className="kiosk-borrow-due">
                  <dt>应还 / Due</dt><dd>{due}（{loanDays} 天 / days）</dd>
                </dl>
                <p className="kiosk-borrow-limit-note">可借 {maxLoans} 本，已借 {activeLoanCount} 本 / {activeLoanCount} of {maxLoans} on loan</p>
              </CatalogCard>
            );
          })}
        </div>
      </CatalogDrawer>
    </>
  );
}

function LoanLimit({ maxLoans, activeLoanCount, picking, overLimit }: { maxLoans: number; activeLoanCount: number; picking: number; overLimit: boolean }) {
  return (
    <div className={`kiosk-borrow-limit ${overLimit ? "is-over" : ""}`}>
      <span>可借 <b>{maxLoans}</b> 本 / Limit</span>
      <span>已借 <b>{activeLoanCount}</b> 本 / On loan</span>
      <span>本次 <b>{picking}</b> 本 / This time</span>
      {overLimit ? <strong><AlertIcon />超出借阅上限 / Over the loan limit</strong> : null}
    </div>
  );
}

/** Step 3: the receipt prints, gets stamped, a ribbon drops, then "My loans" rolls up. */
export function BorrowReceipt({ result, loanCount, onDone }: { result: KioskResult; loanCount: number; onDone: () => void }) {
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
                <b>借阅凭条</b>
                <span className="mono">LOAN RECEIPT · {printedAt.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
              </header>
              <ul>
                {(result.items ?? []).map((item) => (
                  <li key={item.title}>
                    <span>《{item.title}》</span>
                    <span className="mono">应还 {item.dueAt ? formatDate(item.dueAt) : "--"}</span>
                  </li>
                ))}
              </ul>
              <footer>{offline ? "网络恢复后自动提交 / Will sync when online" : "请取走图书与小票，欢迎再来。/ Take your books and receipt."}</footer>
              <span ref={stampRef} className={`kiosk-borrow-stamp ${offline ? "is-queued" : ""}`}>{offline ? "待同步" : "已借出"}</span>
            </div>
          </div>
        </div>

        <div className="kiosk-borrow-summary">
          <div className={`kiosk-result-mark ${result.kind}`}><CheckIcon /></div>
          <h1>{result.title}</h1>
          <p>{result.detail}</p>
          <div className={`kiosk-borrow-count ${showCount ? "is-on" : ""}`} aria-live="polite">
            <span>我的借阅 / My loans</span>
            {showCount ? <b><CountUp value={loanCount} duration={900} /></b> : <b>&nbsp;</b>}
          </div>
          <button className="kiosk-start" onClick={onDone}><span>返回首页</span><small>Back to home</small><span>→</span></button>
        </div>
      </div>
    </section>
  );
}
