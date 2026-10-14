import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactNode, type RefObject } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import { BookSpines, Button, LangSwitch, Logo } from "../shared/components";
import { DemoReaderPicker } from "../shared/DemoReaderPicker";
import { formatDate as formatLocalDate, formatNumber, formatTime } from "../shared/i18n";
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon, OfflineIcon } from "../shared/icons";
import {
  borrowBook, cachedBooks, cachedRules, currentReader, getRules, getStats, listBooks, listLoans, loginCard,
  loginPassword, logout, outboxCount, requestHelp, reserveBook, returnBook, renewLoan, syncOutbox
} from "./kioskApi";
import {
  initialKioskState, kioskReducer, type Book, type KioskResult, type KioskScreen, type KioskUser, type Loan
} from "./kioskState";
import { BorrowFlow, BorrowReceipt } from "./BorrowFlow";
import { LoansFlow, RenewFlow, ReserveFlow, ReturnFlow, ReturnResult } from "./LoanFlows";
import { KioskHome } from "./KioskHome";
import { overdueDays, useKioskText } from "./kioskUi";
import "./kiosk.css";

function bilingual(zh: string, en: string) {
  return <><span>{zh}</span><small>{en}</small></>;
}

function formatDate(value?: string) {
  return value ? formatLocalDate(value) : "--";
}

const ERROR_KEYS: Record<string, string> = {
  INVALID_CARD: "kiosk.error.invalidCard",
  ACCOUNT_LOCKED: "kiosk.error.accountLocked",
  BOOK_UNAVAILABLE: "kiosk.error.bookUnavailable",
  ILLEGAL_BOOK_STATE: "kiosk.error.bookUnavailable",
  BOOK_NOT_FOUND: "kiosk.error.bookNotFound",
  MAX_LOANS_REACHED: "kiosk.error.maxLoans",
  MAX_RENEWALS_REACHED: "kiosk.error.maxRenewals",
  LOAN_RESERVED: "kiosk.error.loanReserved",
  LOAN_NOT_ACTIVE: "kiosk.error.loanNotActive",
  LOAN_NOT_FOUND: "kiosk.error.loanNotActive"
};

/** i18n key for a failed kiosk action; unknown server errors get a generic message in the UI language. */
function errorMessage(error: unknown) {
  const code = (error as Error & { code?: string })?.code;
  return (code && ERROR_KEYS[code]) || "kiosk.error.generic";
}

export function KioskPage() {
  const { t } = useTranslation();
  const location = useLocation();
  // A reader who just signed in on /login arrives identified, so Home shows without an idle or identify step.
  const arrivedAs = (location.state as { reader?: KioskUser } | null)?.reader ?? null;
  const [state, dispatch] = useReducer(kioskReducer, arrivedAs, (reader) => reader ? kioskReducer(initialKioskState, { type: "LOGIN", user: reader }) : initialKioskState);
  const [clock, setClock] = useState(new Date());
  const [card, setCard] = useState("");
  const [pin, setPin] = useState("");
  const [bookInput, setBookInput] = useState("");
  const [returnInput, setReturnInput] = useState("");
  const [reserveInput, setReserveInput] = useState("");
  const [searchResults, setSearchResults] = useState<Book[]>([]);
  const [busy, setBusy] = useState(false);
  const [warningSeconds, setWarningSeconds] = useState<number | null>(null);
  const [reconcileMessage, setReconcileMessage] = useState<{ key: string; values?: Record<string, string | number> } | null>(null);
  const [policy, setPolicy] = useState({ loanDays: 30, maxLoans: 8, maxRenewals: 2, finePerDayCents: 50 });
  const [support, setSupport] = useState<SupportStatus>("idle");
  const navigate = useNavigate();
  const logoPress = useRef<number | undefined>(undefined);
  const logoLongPressed = useRef(false);
  const identifyRef = useRef<HTMLInputElement>(null);
  const idleScanRef = useRef<HTMLInputElement>(null);
  const lastActivity = useRef(Date.now());

  const refreshLoans = useCallback(async () => {
    try {
      const books = await cachedBooks();
      const loans = await listLoans();
      dispatch({ type: "SET_LOANS", loans: loans.map((loan) => ({ ...loan, book: books.find((book) => book.id === loan.book_id) })) });
    } catch {
      // Cached loan state is intentionally kept on the kiosk for offline use.
    }
  }, [state.user]);

  const refreshBooks = useCallback(async (query = "") => {
    try {
      const books = await listBooks(query);
      dispatch({ type: "SET_BOOKS", books });
      return books;
    } catch {
      const books = await cachedBooks();
      if (books.length) dispatch({ type: "SET_BOOKS", books });
      return books;
    }
  }, []);

  const refreshOutbox = useCallback(async () => {
    dispatch({ type: "SET_OUTBOX_COUNT", count: await outboxCount() });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    void refreshBooks();
    void getStats().catch(() => undefined);
    void getRules().catch(() => cachedRules()).then((rules) => {
      const values = new Map(rules.map((rule) => [rule.key, JSON.parse(rule.value_json) as unknown]));
      setPolicy({
        loanDays: Number(values.get("loan_days") ?? 30),
        maxLoans: Number(values.get("max_loans") ?? 8),
        maxRenewals: Number(values.get("max_renewals") ?? 2),
        finePerDayCents: Number(values.get("fine_per_day_cents") ?? 50)
      });
    });
    return () => window.clearInterval(timer);
  }, [refreshBooks]);

  useEffect(() => {
    // One session for both entrances: a reader signed in elsewhere (or before a reload) skips the idle screen.
    let cancelled = false;
    // Drop the hand-over from history, so a reload after logout asks the server instead of reusing it.
    if (arrivedAs) navigate(location.pathname + location.search, { replace: true, state: null });
    void (async () => {
      const reader = arrivedAs ?? await currentReader().catch(() => null);
      if (cancelled || !reader) return;
      if (!arrivedAs) dispatch({ type: "LOGIN", user: reader });
      await refreshLoans();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const markActivity = () => {
      lastActivity.current = Date.now();
      setWarningSeconds(null);
    };
    const events = ["pointerdown", "keydown", "touchstart", "mousemove"];
    events.forEach((event) => window.addEventListener(event, markActivity));
    const timer = window.setInterval(() => {
      if (!state.user) return;
      const idleSeconds = Math.floor((Date.now() - lastActivity.current) / 1000);
      if (idleSeconds >= 25 && idleSeconds < 30) setWarningSeconds(30 - idleSeconds);
      if (idleSeconds >= 30) {
        void logout().catch(() => undefined);
        // Without this the "signing out" dialog stayed over the idle screen.
        setWarningSeconds(null);
        dispatch({ type: "LOGOUT" });
      }
    }, 1000);
    return () => {
      events.forEach((event) => window.removeEventListener(event, markActivity));
      window.clearInterval(timer);
    };
  }, [state.user]);

  useEffect(() => {
    const online = () => {
      dispatch({ type: "SET_NETWORK", network: "syncing" });
      void syncOutbox((message) => setReconcileMessage({ key: "kiosk.sync.conflict", values: { message } }))
        .then(async (result) => {
          await refreshOutbox();
          if (result.synced) setReconcileMessage({ key: "kiosk.sync.synced", values: { n: formatNumber(result.synced) } });
        })
        .finally(() => dispatch({ type: "SET_NETWORK", network: "online" }));
    };
    const offline = () => dispatch({ type: "SET_NETWORK", network: "offline" });
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    void refreshOutbox();
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [refreshOutbox]);

  useEffect(() => {
    if (state.screen === "idle") {
      idleScanRef.current?.focus();
    }
  }, [state.screen]);

  useEffect(() => {
    if (state.screen !== "help") setSupport("idle");
  }, [state.screen]);

  const back = () => dispatch({ type: "BACK" });

  async function identify(number = card) {
    dispatch({ type: "CLEAR_ERROR" });
    if (!number.trim()) {
      dispatch({ type: "INPUT_ERROR", message: "kiosk.error.cardRequired" });
      identifyRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const user = pin ? await loginPassword(number.trim(), pin) : await loginCard(number.trim());
      dispatch({ type: "LOGIN", user });
      await refreshBooks();
      await refreshLoans();
      setCard("");
      setPin("");
    } catch (error) {
      dispatch({ type: "ERROR", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  function go(screen: Exclude<KioskScreen, "idle" | "identify" | "result">) {
    dispatch({ type: "NAVIGATE", screen });
    if (screen === "loans" || screen === "return" || screen === "renew") void refreshLoans();
    if (screen === "borrow" || screen === "reserve") void refreshBooks();
  }

  async function addBook(query: string) {
    const trimmed = query.trim();
    if (!trimmed) return;
    let books: Book[];
    let searched = true;
    try {
      books = await listBooks(trimmed);
    } catch {
      books = await cachedBooks();
      searched = false;
    }
    const candidates = [...books, ...state.books.filter((item) => !books.some((book) => book.id === item.id))];
    // An unknown tag must not silently pick an arbitrary cached book; only trust a real search hit.
    const book = candidates.find((item) => [item.id, item.isbn, item.rfid_tag].includes(trimmed)) ?? (searched ? books[0] : undefined);
    if (!book) {
      dispatch({ type: "INPUT_ERROR", message: "kiosk.error.bookNotFound" });
      return;
    }
    dispatch({ type: "SET_BOOKS", books: candidates });
    dispatch({ type: "ADD_BOOK", book });
    setBookInput("");
  }

  async function confirmBorrow() {
    if (!state.user || state.scannedBookIds.length === 0) return;
    setBusy(true);
    const items: KioskResult["items"] = [];
    let offline = false;
    try {
      for (const book of state.books.filter((item) => state.scannedBookIds.includes(item.id) && item.status === "on_shelf")) {
        const result = await borrowBook({ book, userId: state.user.id, branchId: state.branchId, deviceId: "device-east-1", online: state.network === "online" });
        offline ||= !result.online;
        items.push({ title: book.title, dueAt: result.data.due_at });
      }
      await refreshOutbox();
      dispatch({ type: "RESULT", result: {
        kind: offline ? "offline" : "success",
        title: offline ? "kiosk.result.borrowSaved" : "kiosk.result.borrowed",
        detail: "kiosk.result.borrowDetail",
        items,
        queuedCount: state.outboxCount + items.filter((item) => offline && item.dueAt).length
      } });
      await refreshLoans();
    } catch (error) {
      dispatch({ type: "ERROR", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function performReturn(loan: Loan) {
    setBusy(true);
    try {
      const late = overdueDays(loan);
      const result = await returnBook({ loan, online: state.network === "online" });
      await refreshOutbox();
      dispatch({ type: "RESULT", result: {
        kind: result.online ? "success" : "offline",
        title: result.online ? "kiosk.result.returned" : "kiosk.result.returnSaved",
        detail: loan.book?.shelf_location ? "kiosk.result.returnDetail" : "kiosk.result.returnDetailNoShelf",
        values: { shelf: loan.book?.shelf_location ?? "" },
        items: [{ title: loan.book?.title ?? loan.book_id, shelf: loan.book?.shelf_location, overdueDays: late, fineCents: late * policy.finePerDayCents }]
      } });
    } catch (error) {
      dispatch({ type: "ERROR", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function performRenew() {
    const selected = state.loans.filter((loan) => state.selectedLoanIds.includes(loan.id));
    if (!selected.length) {
      dispatch({ type: "INPUT_ERROR", message: "kiosk.error.selectBook" });
      return;
    }
    setBusy(true);
    try {
      let offline = false;
      const items: KioskResult["items"] = [];
      for (const loan of selected) {
        if (loan.renew_count >= policy.maxRenewals) throw Object.assign(new Error("MAX_RENEWALS_REACHED"), { code: "MAX_RENEWALS_REACHED" });
        const result = await renewLoan({ loan, online: state.network === "online" });
        offline ||= !result.online;
        items.push({ title: loan.book?.title ?? loan.book_id, dueAt: result.online ? result.data.due_at : new Date(Date.now() + policy.loanDays * 86400000).toISOString() });
      }
      await refreshOutbox();
      dispatch({ type: "RESULT", result: { kind: offline ? "offline" : "success", title: offline ? "kiosk.result.renewSaved" : "kiosk.result.renewed", detail: "kiosk.result.renewDetail", items } });
    } catch (error) {
      dispatch({ type: "ERROR", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function performReserve(book: Book) {
    if (!state.user) return;
    setBusy(true);
    try {
      const result = await reserveBook({ book, userId: state.user.id, online: state.network === "online" });
      await refreshOutbox();
      dispatch({ type: "RESULT", result: { kind: result.online ? "success" : "offline", title: result.online ? "kiosk.result.reserved" : "kiosk.result.reserveSaved", detail: "kiosk.result.reserveDetail", values: { title: book.title } } });
    } catch (error) {
      dispatch({ type: "ERROR", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  /** Home catalogue search: the books API, or the cached catalogue when offline. */
  async function searchCatalogue(query: string) {
    try {
      return await listBooks(query);
    } catch {
      const needle = query.toLowerCase();
      const books = state.books.length ? state.books : await cachedBooks();
      return books.filter((book) => [book.title, book.author, book.isbn].some((field) => field?.toLowerCase().includes(needle)));
    }
  }

  function reserveFromSearch(book: Book) {
    setReserveInput(book.title);
    setSearchResults([book]);
    go("reserve");
  }

  async function callSupport() {
    setBusy(true);
    try {
      await requestHelp(state.branchId, `Kiosk remote support requested by ${state.user?.account ?? "guest"}`);
      setSupport("sent");
    } catch {
      setSupport("queued");
    } finally {
      setBusy(false);
    }
  }

  const activeLoans = useMemo(() => state.loans.filter((loan) => ["active", "overdue"].includes(loan.status)), [state.loans]);
  const today = formatTime(clock);

  function startLogoPress() {
    logoLongPressed.current = false;
    logoPress.current = window.setTimeout(() => {
      logoLongPressed.current = true;
      dispatch({ type: "SET_DEV", open: true });
    }, 900);
  }
  async function signOut() {
    try {
      await logout();
    } catch {
      // The session may already be gone (or the kiosk is offline); leave either way.
    }
    dispatch({ type: "LOGOUT" });
    navigate("/login", { replace: true });
  }

  function endLogoPress() {
    if (logoPress.current) window.clearTimeout(logoPress.current);
  }

  const idleScreen = <IdleScreen time={today} occupancy={state.occupancy} capacity={state.capacity} onStart={() => dispatch({ type: "SHOW_IDENTIFY" })} scanRef={idleScanRef} onScan={(value) => { setCard(value); dispatch({ type: "SHOW_IDENTIFY" }); }} />;
  const homeScreen = state.user ? <KioskHome user={state.user.name} loans={activeLoans} onNavigate={go} onSearch={searchCatalogue} onReserve={reserveFromSearch} /> : null;

  return (
    <main className="kiosk-page" data-network={state.network}>
      <header className="kiosk-topbar">
        {/* Tap goes to /login; a long press still opens the developer drawer. */}
        <Link
          to="/login"
          className="kiosk-logo-button"
          onPointerDown={startLogoPress}
          onPointerUp={endLogoPress}
          onPointerLeave={endLogoPress}
          onContextMenu={(event) => event.preventDefault()}
          onClick={(event) => { if (logoLongPressed.current) event.preventDefault(); }}
          aria-label={t("kiosk.header.loginPage")}
        >
          <Logo />
        </Link>
        <div className="kiosk-branch">
          <strong>{t(`kiosk.branch.${state.branchId}`, { defaultValue: state.branchId })}</strong>
          <span>{t("kiosk.header.hours", { from: "08:00", to: "22:00" })}</span>
        </div>
        <div className="kiosk-top-actions">
          <div className="kiosk-lang"><LangSwitch /></div>
          <button className="kiosk-icon-button" onClick={() => dispatch({ type: "NAVIGATE", screen: "help" })} aria-label={t("kiosk.header.help")}>?</button>
          <button className="kiosk-exit" onClick={() => void signOut()}>{t("nav.logout")}</button>
        </div>
      </header>

      {state.network !== "online" || state.outboxCount > 0 ? (
        <div className="kiosk-offline-banner" role="status">
          <OfflineIcon />
          <span>{t(state.network === "syncing" ? "kiosk.sync.syncing" : "kiosk.sync.offline")} · {t("kiosk.sync.saved", { n: formatNumber(state.outboxCount) })}</span>
        </div>
      ) : null}
      {reconcileMessage ? <div className="kiosk-reconcile" role="alert"><AlertIcon />{t(reconcileMessage.key, reconcileMessage.values)}<button onClick={() => setReconcileMessage(null)}><CloseIcon /></button></div> : null}

      {state.screen === "idle" ? (
        idleScreen
      ) : state.screen === "identify" ? (
        <IdentifyScreen card={card} pin={pin} setCard={setCard} setPin={setPin} onSubmit={() => void identify()} onDemoPick={(number) => { setCard(number); void identify(number); }} error={state.error || state.inputError} inputRef={identifyRef} loading={busy} />
      ) : state.screen === "home" && state.user ? (
        homeScreen
      ) : state.screen === "borrow" && state.user ? (
        <BorrowScreen books={state.books} scannedBookIds={state.scannedBookIds} step={state.borrowStep} input={bookInput} setInput={setBookInput} error={state.error || state.inputError} onAdd={() => addBook(bookInput)} onRemove={(id) => dispatch({ type: "REMOVE_BOOK", bookId: id })} onNext={() => dispatch({ type: "SET_BORROW_STEP", step: state.borrowStep === "scan" ? "confirm" : "receipt" })} onConfirm={() => void confirmBorrow()} onBack={() => go("home")} onStepBack={back} busy={busy} loanDays={policy.loanDays} maxLoans={policy.maxLoans} activeLoanCount={activeLoans.length} />
      ) : state.screen === "return" && state.user ? (
        <ReturnScreen loans={activeLoans} finePerDayCents={policy.finePerDayCents} onReturn={(loan) => void performReturn(loan)} onManualReturn={() => {
          const book = state.books.find((item) => [item.id, item.isbn, item.rfid_tag].includes(returnInput.trim()));
          const loan = activeLoans.find((item) => item.book_id === book?.id);
          if (loan) void performReturn(loan);
          else dispatch({ type: "INPUT_ERROR", message: "kiosk.error.noMatchingLoan" });
          setReturnInput("");
        }} input={returnInput} setInput={setReturnInput} onBack={back} busy={busy} error={state.error || state.inputError} />
      ) : state.screen === "renew" && state.user ? (
        <RenewScreen loans={activeLoans} selected={state.selectedLoanIds} maxRenewals={policy.maxRenewals} loanDays={policy.loanDays} onSelect={(ids) => dispatch({ type: "SET_SELECTED_LOANS", ids })} onSubmit={() => void performRenew()} onBack={back} busy={busy} error={state.error || state.inputError} />
      ) : state.screen === "reserve" && state.user ? (
        <ReserveScreen query={reserveInput} setQuery={setReserveInput} results={searchResults} onSearch={() => void listBooks(reserveInput).then(setSearchResults).catch(() => setSearchResults(state.books))} onReserve={(book) => void performReserve(book)} onBack={back} busy={busy} error={state.error || state.inputError} />
      ) : state.screen === "loans" && state.user ? (
        <LoansScreen loans={activeLoans} finePerDayCents={policy.finePerDayCents} onBack={back} />
      ) : state.screen === "help" ? (
        <HelpScreen onCall={() => void callSupport()} onBack={back} busy={busy} support={support} />
      ) : state.screen === "result" && state.result && state.flow === "borrow" && state.result.kind !== "warning" ? (
        <BorrowReceipt result={state.result} loanCount={activeLoans.length} onDone={() => go("home")} />
      ) : state.screen === "result" && state.result && state.flow === "return" && state.result.kind !== "warning" ? (
        <ReturnResult result={state.result} onDone={() => go("home")} />
      ) : state.screen === "result" && state.result ? (
        <ResultScreen result={state.result} onDone={() => go("home")} />
      ) : (
        // The reducer never leaves a state without a screen; this is the last line of defence.
        state.user ? homeScreen : idleScreen
      )}

      {state.screen !== "idle" && state.screen !== "home" ? (
        <KioskNav onBack={back} onHome={state.user ? () => dispatch({ type: "HOME" }) : undefined} />
      ) : null}

      {warningSeconds !== null ? <div className="kiosk-timeout" role="dialog"><div><InfoIcon /><h2>即将退出 / Signing out soon</h2><p>{warningSeconds} 秒后自动退出 / Auto logout in {warningSeconds}s</p><button onClick={() => setWarningSeconds(null)}>继续使用 / Continue</button></div></div> : null}
      {state.devOpen ? <DevDrawer state={state} dispatch={dispatch} onClose={() => dispatch({ type: "SET_DEV", open: false })} onPlace={() => {
        const book = state.books.find((item) => item.status === "on_shelf" && !state.scannedBookIds.includes(item.id));
        if (book) dispatch({ type: "ADD_BOOK", book });
      }} onOffline={() => {
        if (state.network === "offline") {
          dispatch({ type: "SET_NETWORK", network: "syncing" });
          void syncOutbox((message) => setReconcileMessage({ key: "kiosk.sync.conflict", values: { message } }))
            .then(async (result) => {
              await refreshOutbox();
              if (result.synced) setReconcileMessage({ key: "kiosk.sync.synced", values: { n: formatNumber(result.synced) } });
            })
            .finally(() => dispatch({ type: "SET_NETWORK", network: "online" }));
        } else dispatch({ type: "SET_NETWORK", network: "offline" });
      }} onScan={() => { setCard("20240001"); dispatch({ type: "SHOW_IDENTIFY" }); }} /> : null}
    </main>
  );
}

function IdleScreen({ time, occupancy, capacity, onStart, scanRef, onScan }: { time: string; occupancy: number; capacity: number; onStart: () => void; scanRef: RefObject<HTMLInputElement | null>; onScan: (value: string) => void }) {
  const { t } = useTranslation();
  return <section className="kiosk-idle">
    <input ref={scanRef} className="kiosk-idle-scan-buffer" aria-label={t("kiosk.idle.scanner")} onKeyDown={(event) => {
      if (event.key === "Enter") {
        const value = event.currentTarget.value.trim();
        if (value) onScan(value);
        event.currentTarget.value = "";
      }
    }} />
    <div className="kiosk-idle-copy">
      <p className="kiosk-eyebrow">{t("kiosk.idle.eyebrow")}</p>
      <h1>{t("app.name")}</h1>
      <div className="kiosk-clock">{time}</div>
      <p className="kiosk-presence"><Trans i18nKey="kiosk.idle.presence" values={{ people: formatNumber(occupancy), capacity: formatNumber(capacity) }} components={{ b: <strong /> }} /><br /><small>{t(occupancy < capacity ? "kiosk.idle.calm" : "kiosk.idle.full")}</small></p>
      <button className="kiosk-start" onClick={onStart}><span>{t("kiosk.idle.start")}</span><span>→</span></button>
    </div>
    <div className="kiosk-idle-art"><BookSpines seed={32} /><div className="kiosk-art-label">{t("kiosk.idle.artPlace")}<br /><span>{t("kiosk.idle.artRoom")}</span></div></div>
  </section>;
}

function IdentifyScreen({ card, pin, setCard, setPin, onSubmit, onDemoPick, error, inputRef, loading }: { card: string; pin: string; setCard: (value: string) => void; setPin: (value: string) => void; onSubmit: () => void; onDemoPick: (card: string) => void; error: string; inputRef: RefObject<HTMLInputElement | null>; loading: boolean }) {
  const text = useKioskText();
  return <KioskShell title="identify" onBack={undefined}>
    <div className="kiosk-identify">
      <div className="kiosk-scan-mark">◎</div>
      <h2>刷卡或输入证号<small>Tap your card or enter card number</small></h2>
      <input ref={inputRef} className="kiosk-scan-input" autoFocus value={card} onChange={(event) => setCard(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSubmit(); }} placeholder="20240001" aria-label="Reader card number" />
      <label className="kiosk-pin-field"><span>PIN（可选） / Optional PIN</span><input inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSubmit(); }} placeholder="••••" /></label>
      {error ? <p className="kiosk-error" role="alert"><AlertIcon />{text(error)}</p> : null}
      <Button loading={loading} onClick={onSubmit}>{bilingual("继续", "Continue")}</Button>
      <DemoReaderPicker className="kiosk-demo-readers" disabled={loading} onPick={onDemoPick} />
      <p className="kiosk-hint">支持读者证、二维码和键盘扫码器<br /><small>Cards, QR codes, and keyboard barcode scanners supported</small></p>
    </div>
  </KioskShell>;
}

type ShellScreen = Exclude<KioskScreen, "idle" | "home" | "result">;

function KioskShell({ title, onBack, children }: { title: ShellScreen; onBack: (() => void) | undefined; children: ReactNode }) {
  const { t } = useTranslation();
  return <section className="kiosk-shell"><div className="kiosk-shell-heading">{onBack ? <button className="kiosk-back" onClick={onBack} aria-label={t("kiosk.nav.back")}><span aria-hidden="true">←</span></button> : null}<h1>{t(`kiosk.screen.${title}`)}</h1></div>{children}</section>;
}

function BorrowScreen({ onStepBack, ...props }: Parameters<typeof BorrowFlow>[0] & { onStepBack: () => void }) {
  return <KioskShell title="borrow" onBack={onStepBack}><BorrowFlow {...props} /></KioskShell>;
}

function ReturnScreen({ onBack, ...props }: Parameters<typeof ReturnFlow>[0] & { onBack: () => void }) {
  return <KioskShell title="return" onBack={onBack}><ReturnFlow {...props} /></KioskShell>;
}

function RenewScreen(props: Parameters<typeof RenewFlow>[0]) {
  return <KioskShell title="renew" onBack={props.onBack}><RenewFlow {...props} /></KioskShell>;
}

function ReserveScreen({ onBack, ...props }: Parameters<typeof ReserveFlow>[0] & { onBack: () => void }) {
  return <KioskShell title="reserve" onBack={onBack}><ReserveFlow {...props} /></KioskShell>;
}

function LoansScreen({ onBack, ...props }: Parameters<typeof LoansFlow>[0] & { onBack: () => void }) {
  return <KioskShell title="loans" onBack={onBack}><LoansFlow {...props} /></KioskShell>;
}

type SupportStatus = "idle" | "sent" | "queued";

const HELP_STEPS = [
  {
    key: "card",
    art: <svg viewBox="0 0 96 72" aria-hidden="true"><rect x="10" y="40" width="76" height="12" rx="6" className="is-fill" /><rect x="24" y="8" width="48" height="34" rx="5" /><path d="M24 18h48" /><rect x="30" y="24" width="10" height="12" rx="2" /><path d="M46 28h18M46 34h12" /><path d="M78 20a10 10 0 0 1 0 12M84 15a17 17 0 0 1 0 22" className="is-accent" /></svg>
  },
  {
    key: "tray",
    art: <svg viewBox="0 0 96 72" aria-hidden="true"><rect x="10" y="54" width="76" height="8" rx="4" className="is-fill" /><rect x="34" y="14" width="26" height="38" rx="3" /><path d="M40 14v38" /><circle cx="47" cy="33" r="22" className="is-accent is-dashed" /></svg>
  },
  {
    key: "receipt",
    art: <svg viewBox="0 0 96 72" aria-hidden="true"><rect x="18" y="8" width="60" height="16" rx="4" className="is-fill" /><path d="M28 24v40l6-4 6 4 6-4 6 4 6-4 6 4V24" /><path d="M36 40l7 7 14-14" className="is-accent" /></svg>
  }
];

function HelpScreen({ onCall, onBack, busy, support }: { onCall: () => void; onBack: () => void; busy: boolean; support: SupportStatus }) {
  const { t } = useTranslation();
  const confirmRef = useRef<HTMLParagraphElement>(null);
  // Keep the confirmation clear of the fixed bottom navigation on short screens.
  useEffect(() => {
    if (support !== "idle") confirmRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [support]);
  return <KioskShell title="help" onBack={onBack}>
    <div className="kiosk-help">
      <ol className="kiosk-help-steps">
        {HELP_STEPS.map((step, index) => (
          <li key={step.key}>
            <span className="kiosk-help-art">{step.art}</span>
            <b>{index + 1}</b>
            <span>{t(`kiosk.help.step.${step.key}`)}</span>
          </li>
        ))}
      </ol>
      <p>{t("kiosk.help.fault")}</p>
      <Button loading={busy} onClick={onCall}>{t("kiosk.help.call")}</Button>
      <p ref={confirmRef} className={`kiosk-help-confirm ${support !== "idle" ? "is-on" : ""}`} role="status">
        {support === "sent" ? <><CheckIcon />{t("kiosk.help.sent")}</> : null}
        {support === "queued" ? <><InfoIcon />{t("kiosk.help.queued")}</> : null}
      </p>
    </div>
  </KioskShell>;
}

/** Bottom-left navigation on every screen except idle and home. Back steps back one screen; Home keeps the session. */
function KioskNav({ onBack, onHome }: { onBack: () => void; onHome?: () => void }) {
  const { t } = useTranslation();
  return (
    <nav className="kiosk-nav" aria-label={t("kiosk.nav.label")}>
      <button type="button" className="kiosk-nav-back" onClick={onBack}>
        <span aria-hidden="true">←</span>
        <span>{t("kiosk.nav.back")}</span>
      </button>
      {onHome ? (
        <button type="button" className="kiosk-nav-home" onClick={onHome}>
          <span aria-hidden="true">⌂</span>
          <span>{t("kiosk.nav.home")}</span>
        </button>
      ) : null}
    </nav>
  );
}

function ResultScreen({ result, onDone }: { result: KioskResult; onDone: () => void }) {
  const { t } = useTranslation();
  const text = useKioskText();
  return <section className="kiosk-result"><div className={`kiosk-result-mark ${result.kind}`}><CheckIcon /></div><h1>{text(result.title, result.values)}</h1><p>{text(result.detail, result.values)}</p>{result.items?.length ? <div className="kiosk-result-items">{result.items.map((item) => <div key={item.title}><strong>{item.title}</strong><span>{item.dueAt ? t("kiosk.flow.dueOn", { date: formatDate(item.dueAt) }) : item.shelf ?? ""}</span></div>)}</div> : null}<button className="kiosk-start" onClick={onDone}><span>{t("kiosk.flow.backHome")}</span><span>→</span></button></section>;
}


function DevDrawer({ state, dispatch, onClose, onPlace, onOffline, onScan }: { state: typeof initialKioskState; dispatch: Dispatch<Parameters<typeof kioskReducer>[1]>; onClose: () => void; onPlace: () => void; onOffline: () => void; onScan: () => void }) {
  return <aside className="kiosk-dev-drawer"><div className="kiosk-dev-head"><strong>DEV DRAWER</strong><button onClick={onClose}><CloseIcon /></button></div><p>Simulator controls · hidden in production</p><button onClick={onPlace}>放置模拟图书 / Place book</button><button onClick={onScan}>扫描演示读者 / Scan demo card</button><button onClick={onOffline}>{state.network === "offline" ? "恢复网络 / Go online" : "断开网络 / Go offline"}</button><button onClick={() => dispatch({ type: "RESULT", result: { kind: "warning", title: "闸机测试告警 / Gate alarm test", detail: "已创建模拟门禁事件 / Simulated gate event created." } })}>触发闸机告警 / Trigger gate alarm</button></aside>;
}
