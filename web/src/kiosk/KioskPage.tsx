import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactNode, type RefObject } from "react";
import { BookSpines, Button, Logo, StatusBadge } from "../shared/components";
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon, OfflineIcon } from "../shared/icons";
import {
  borrowBook, cachedBooks, cachedRules, getRules, getStats, listBooks, listLoans, loginCard,
  loginPassword, logout, outboxCount, requestHelp, reserveBook, returnBook, renewLoan, syncOutbox
} from "./kioskApi";
import {
  initialKioskState, kioskReducer, type Book, type KioskResult, type KioskScreen, type Loan
} from "./kioskState";
import "./kiosk.css";

const screenCopy: Record<KioskScreen, { zh: string; en: string }> = {
  idle: { zh: "欢迎进入", en: "Welcome" },
  identify: { zh: "请先验证身份", en: "Identify yourself" },
  home: { zh: "你好，", en: "Hello, " },
  borrow: { zh: "借阅图书", en: "Borrow books" },
  return: { zh: "归还图书", en: "Return books" },
  renew: { zh: "续借图书", en: "Renew books" },
  reserve: { zh: "预约图书", en: "Reserve a book" },
  loans: { zh: "我的借阅", en: "My loans" },
  help: { zh: "需要帮助？", en: "Need help?" },
  result: { zh: "已完成", en: "Completed" }
};

function bilingual(zh: string, en: string) {
  return <><span>{zh}</span><small>{en}</small></>;
}

function formatDate(value?: string) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function daysUntil(value: string) {
  return Math.ceil((new Date(value).getTime() - Date.now()) / 86400000);
}

function errorMessage(error: unknown) {
  const code = (error as Error & { code?: string })?.code;
  if (code === "INVALID_CARD") return "读者证未识别，请重试 / Reader card not recognized.";
  if (code === "ACCOUNT_LOCKED") return "账号暂时锁定，请联系馆员 / Account locked. Please call support.";
  if (code === "BOOK_UNAVAILABLE") return "这本书刚刚被借走了 / This book is no longer available.";
  if (code === "MAX_LOANS_REACHED") return "已达到借阅上限 / Your loan limit has been reached.";
  if (code === "MAX_RENEWALS_REACHED") return "这本书已达到续借次数上限 / Renewal limit reached.";
  if (code === "LOAN_RESERVED") return "这本书已被其他读者预约，暂时不能续借 / This book is reserved by another reader.";
  return error instanceof Error ? error.message : "操作未完成，请稍后再试 / Please try again.";
}

export function KioskPage() {
  const [state, dispatch] = useReducer(kioskReducer, initialKioskState);
  const [clock, setClock] = useState(new Date());
  const [card, setCard] = useState("");
  const [pin, setPin] = useState("");
  const [bookInput, setBookInput] = useState("");
  const [returnInput, setReturnInput] = useState("");
  const [reserveInput, setReserveInput] = useState("");
  const [searchResults, setSearchResults] = useState<Book[]>([]);
  const [busy, setBusy] = useState(false);
  const [warningSeconds, setWarningSeconds] = useState<number | null>(null);
  const [reconcileMessage, setReconcileMessage] = useState("");
  const [policy, setPolicy] = useState({ loanDays: 30, maxLoans: 8, maxRenewals: 2, finePerDayCents: 50 });
  const logoPress = useRef<number | undefined>(undefined);
  const identifyRef = useRef<HTMLInputElement>(null);
  const idleScanRef = useRef<HTMLInputElement>(null);
  const lastActivity = useRef(Date.now());

  const speak = useCallback((zh: string, en: string) => {
    if (!state.voiceEnabled || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(`${zh}. ${en}`);
    utterance.lang = "zh-CN";
    utterance.rate = 0.92;
    window.speechSynthesis.speak(utterance);
  }, [state.voiceEnabled]);

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
      void syncOutbox((message) => setReconcileMessage(`同步冲突 / Reconciliation: ${message}`))
        .then(async (result) => {
          await refreshOutbox();
          if (result.synced) setReconcileMessage(`已同步 ${result.synced} 笔操作 / Synced ${result.synced} operations`);
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
    const prompt: Record<KioskScreen, [string, string]> = {
      idle: ["请刷读者证或扫码入馆", "Tap your card or scan QR to enter"],
      identify: ["请刷读者证，或输入证号和 PIN", "Tap your card, or enter card number and PIN"],
      borrow: ["请将图书放在 RFID 托盘上", "Place books on the RFID tray"],
      return: ["请将要归还的图书放在托盘上", "Place books to return on the tray"],
      renew: ["选择要续借的图书", "Choose books to renew"],
      reserve: ["搜索并预约一本已借出的图书", "Search and reserve a borrowed book"],
      loans: ["这是您的借阅记录", "Here are your loans"],
      help: ["请选择需要的帮助", "Choose the help you need"],
      home: ["请选择一项服务", "Choose a service"],
      result: ["操作已完成，请取走图书", "Done. Please take your books"]
    };
    speak(...prompt[state.screen]);
  }, [speak, state.screen]);

  useEffect(() => {
    if (state.screen === "idle") {
      idleScanRef.current?.focus();
    }
  }, [state.screen]);

  async function identify() {
    dispatch({ type: "CLEAR_ERROR" });
    if (!card.trim()) {
      dispatch({ type: "INPUT_ERROR", message: "请输入读者证号 / Enter your card number." });
      identifyRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const user = pin ? await loginPassword(card.trim(), pin) : await loginCard(card.trim());
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
    try {
      books = await listBooks(trimmed);
    } catch {
      books = await cachedBooks();
    }
    const candidates = [...books, ...state.books.filter((item) => !books.some((book) => book.id === item.id))];
    const book = candidates.find((item) => [item.id, item.isbn, item.rfid_tag].includes(trimmed)) ?? candidates[0];
    if (!book) {
      dispatch({ type: "INPUT_ERROR", message: "没有找到这本书 / Book not found." });
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
        title: offline ? "已保存，网络恢复后自动提交 / Saved for sync" : "借阅成功 / Borrowed",
        detail: "请取走图书，闸机已授权 / Please take your books. Gate authorized.",
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
      const result = await returnBook({ loan, online: state.network === "online" });
      await refreshOutbox();
      dispatch({ type: "RESULT", result: {
        kind: result.online ? "success" : "offline",
        title: result.online ? "归还成功 / Returned" : "归还已保存 / Return saved",
        detail: `请放回 ${loan.book?.shelf_location ?? "对应书架"} / Please return it to the shelf.`,
        items: [{ title: loan.book?.title ?? "Book", shelf: loan.book?.shelf_location }]
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
      dispatch({ type: "INPUT_ERROR", message: "请先选择图书 / Select at least one book." });
      return;
    }
    setBusy(true);
    try {
      let offline = false;
      const items: KioskResult["items"] = [];
      for (const loan of selected) {
        if (loan.renew_count >= policy.maxRenewals) throw new Error(`《${loan.book?.title ?? "这本书"}》已达到续借上限 / Renewal limit reached.`);
        const result = await renewLoan({ loan, online: state.network === "online" });
        offline ||= !result.online;
        items.push({ title: loan.book?.title ?? "Book", dueAt: result.online ? result.data.due_at : new Date(Date.now() + policy.loanDays * 86400000).toISOString() });
      }
      await refreshOutbox();
      dispatch({ type: "RESULT", result: { kind: offline ? "offline" : "success", title: offline ? "续借已保存 / Renewal saved" : "续借成功 / Renewed", detail: "新的到期日如下 / New due dates are below.", items } });
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
      dispatch({ type: "RESULT", result: { kind: result.online ? "success" : "offline", title: result.online ? "预约成功 / Reserved" : "预约已保存 / Reservation saved", detail: `我们会为您保留《${book.title}》 / We will hold this book for you.` } });
    } catch (error) {
      dispatch({ type: "ERROR", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function callSupport() {
    setBusy(true);
    try {
      await requestHelp(state.branchId, `Kiosk remote support requested by ${state.user?.account ?? "guest"}`);
      dispatch({ type: "RESULT", result: { kind: "success", title: "已呼叫远程支持 / Support called", detail: "馆员会尽快回应，请留在自助机旁 / A librarian will respond shortly." } });
    } catch {
      dispatch({ type: "RESULT", result: { kind: "offline", title: "请求已记录 / Request noted", detail: "网络恢复后会通知馆员 / The request will sync when online." } });
    } finally {
      setBusy(false);
    }
  }

  const activeLoans = useMemo(() => state.loans.filter((loan) => ["active", "overdue"].includes(loan.status)), [state.loans]);
  const openLoans = activeLoans.filter((loan) => loan.status === "active").length;
  const overdueLoans = activeLoans.filter((loan) => loan.status === "overdue").length;
  const dueSoon = activeLoans.filter((loan) => loan.status === "active" && daysUntil(loan.due_at) <= 7).length;
  const today = clock.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  function startLogoPress() {
    logoPress.current = window.setTimeout(() => dispatch({ type: "SET_DEV", open: true }), 900);
  }
  function endLogoPress() {
    if (logoPress.current) window.clearTimeout(logoPress.current);
  }

  return (
    <main className="kiosk-page" data-network={state.network}>
      <header className="kiosk-topbar">
        <button className="kiosk-logo-button" onPointerDown={startLogoPress} onPointerUp={endLogoPress} onPointerLeave={endLogoPress} aria-label="Open developer drawer">
          <Logo />
        </button>
        <div className="kiosk-branch">
          <strong>{state.branchName}</strong>
          <span>OPEN 08:00–22:00 · 今日开放 / Open today</span>
        </div>
        <div className="kiosk-top-actions">
          <button className="kiosk-icon-button" onClick={() => dispatch({ type: "TOGGLE_VOICE" })} aria-label="Toggle voice">{state.voiceEnabled ? "声" : "静"}</button>
          <button className="kiosk-icon-button" onClick={() => dispatch({ type: "NAVIGATE", screen: "help" })} aria-label="Help">?</button>
          {state.user ? <button className="kiosk-exit" onClick={() => { void logout().catch(() => undefined); dispatch({ type: "LOGOUT" }); }}>{bilingual("退出", "Exit")}</button> : null}
        </div>
      </header>

      {state.network !== "online" || state.outboxCount > 0 ? (
        <div className="kiosk-offline-banner" role="status">
          <OfflineIcon />
          <span>{state.network === "syncing" ? "正在同步 / Syncing" : "离线模式 / Offline mode"} · 已保存 {state.outboxCount} 笔操作 / {state.outboxCount} saved</span>
        </div>
      ) : null}
      {reconcileMessage ? <div className="kiosk-reconcile" role="alert"><AlertIcon />{reconcileMessage}<button onClick={() => setReconcileMessage("")}><CloseIcon /></button></div> : null}

      {state.screen === "idle" ? (
        <IdleScreen time={today} occupancy={state.occupancy} capacity={state.capacity} onStart={() => dispatch({ type: "SHOW_IDENTIFY" })} scanRef={idleScanRef} onScan={(value) => { setCard(value); dispatch({ type: "SHOW_IDENTIFY" }); }} />
      ) : state.screen === "identify" ? (
        <IdentifyScreen card={card} pin={pin} setCard={setCard} setPin={setPin} onSubmit={() => void identify()} error={state.error || state.inputError} inputRef={identifyRef} loading={busy} />
      ) : state.screen === "home" && state.user ? (
        <HomeScreen user={state.user.name} openLoans={openLoans} dueSoon={dueSoon} overdue={overdueLoans} onNavigate={go} />
      ) : state.screen === "borrow" ? (
        <BorrowScreen books={state.books} scannedBookIds={state.scannedBookIds} step={state.borrowStep} input={bookInput} setInput={setBookInput} error={state.error || state.inputError} onAdd={() => void addBook(bookInput)} onRemove={(id) => dispatch({ type: "REMOVE_BOOK", bookId: id })} onNext={() => dispatch({ type: "SET_BORROW_STEP", step: state.borrowStep === "scan" ? "confirm" : "receipt" })} onConfirm={() => void confirmBorrow()} onBack={() => go("home")} busy={busy} loanDays={policy.loanDays} maxLoans={policy.maxLoans} />
      ) : state.screen === "return" ? (
        <ReturnScreen loans={activeLoans} finePerDayCents={policy.finePerDayCents} onReturn={(loan) => void performReturn(loan)} onManualReturn={() => {
          const book = state.books.find((item) => [item.id, item.isbn, item.rfid_tag].includes(returnInput.trim()));
          const loan = activeLoans.find((item) => item.book_id === book?.id);
          if (loan) void performReturn(loan);
          else dispatch({ type: "INPUT_ERROR", message: "未找到您的在借图书 / No matching active loan found." });
          setReturnInput("");
        }} input={returnInput} setInput={setReturnInput} onBack={() => go("home")} busy={busy} error={state.error || state.inputError} />
      ) : state.screen === "renew" ? (
        <RenewScreen loans={activeLoans} selected={state.selectedLoanIds} maxRenewals={policy.maxRenewals} loanDays={policy.loanDays} onSelect={(ids) => dispatch({ type: "SET_SELECTED_LOANS", ids })} onSubmit={() => void performRenew()} onBack={() => go("home")} busy={busy} error={state.error || state.inputError} />
      ) : state.screen === "reserve" ? (
        <ReserveScreen query={reserveInput} setQuery={setReserveInput} results={searchResults} onSearch={() => void listBooks(reserveInput).then(setSearchResults).catch(() => setSearchResults(state.books))} onReserve={(book) => void performReserve(book)} onBack={() => go("home")} busy={busy} />
      ) : state.screen === "loans" ? (
        <LoansScreen loans={activeLoans} onBack={() => go("home")} />
      ) : state.screen === "help" ? (
        <HelpScreen onCall={() => void callSupport()} onBack={() => go("home")} busy={busy} />
      ) : state.screen === "result" && state.result ? (
        <ResultScreen result={state.result} onDone={() => go("home")} />
      ) : null}

      {warningSeconds !== null ? <div className="kiosk-timeout" role="dialog"><div><InfoIcon /><h2>即将退出 / Signing out soon</h2><p>{warningSeconds} 秒后自动退出 / Auto logout in {warningSeconds}s</p><button onClick={() => setWarningSeconds(null)}>继续使用 / Continue</button></div></div> : null}
      {state.devOpen ? <DevDrawer state={state} dispatch={dispatch} onClose={() => dispatch({ type: "SET_DEV", open: false })} onPlace={() => {
        const book = state.books.find((item) => item.status === "on_shelf" && !state.scannedBookIds.includes(item.id));
        if (book) dispatch({ type: "ADD_BOOK", book });
      }} onOffline={() => {
        if (state.network === "offline") {
          dispatch({ type: "SET_NETWORK", network: "syncing" });
          void syncOutbox((message) => setReconcileMessage(`同步冲突 / Reconciliation: ${message}`))
            .then(async (result) => {
              await refreshOutbox();
              if (result.synced) setReconcileMessage(`已同步 ${result.synced} 笔操作 / Synced ${result.synced} operations`);
            })
            .finally(() => dispatch({ type: "SET_NETWORK", network: "online" }));
        } else dispatch({ type: "SET_NETWORK", network: "offline" });
      }} onScan={() => { setCard("20240001"); dispatch({ type: "SHOW_IDENTIFY" }); }} /> : null}
    </main>
  );
}

function IdleScreen({ time, occupancy, capacity, onStart, scanRef, onScan }: { time: string; occupancy: number; capacity: number; onStart: () => void; scanRef: RefObject<HTMLInputElement | null>; onScan: (value: string) => void }) {
  return <section className="kiosk-idle">
    <input ref={scanRef} className="kiosk-idle-scan-buffer" aria-label="Card scanner input" onKeyDown={(event) => {
      if (event.key === "Enter") {
        const value = event.currentTarget.value.trim();
        if (value) onScan(value);
        event.currentTarget.value = "";
      }
    }} />
    <div className="kiosk-idle-copy">
      <p className="kiosk-eyebrow">QUIET ARCHIVE · SELF-SERVICE</p>
      <h1>无人值守图书馆<small>Unmanned Library</small></h1>
      <div className="kiosk-clock">{time}</div>
      <p className="kiosk-presence">现在馆内 <strong>{occupancy}</strong> 人 / {capacity} 人容量<br /><small>{occupancy < capacity ? "馆内安静开放 / Open and calm" : "当前已满 / Currently full"}</small></p>
      <button className="kiosk-start" onClick={onStart}>{bilingual("请刷读者证或扫码入馆", "Tap your card or scan QR to enter")}<span>→</span></button>
    </div>
    <div className="kiosk-idle-art"><BookSpines seed={32} /><div className="kiosk-art-label">EAST CAMPUS<br /><span>READING ROOM</span></div></div>
  </section>;
}

function IdentifyScreen({ card, pin, setCard, setPin, onSubmit, error, inputRef, loading }: { card: string; pin: string; setCard: (value: string) => void; setPin: (value: string) => void; onSubmit: () => void; error: string; inputRef: RefObject<HTMLInputElement | null>; loading: boolean }) {
  return <KioskShell title={screenCopy.identify} onBack={undefined}>
    <div className="kiosk-identify">
      <div className="kiosk-scan-mark">◎</div>
      <h2>刷卡或输入证号<small>Tap your card or enter card number</small></h2>
      <input ref={inputRef} className="kiosk-scan-input" autoFocus value={card} onChange={(event) => setCard(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSubmit(); }} placeholder="20240001" aria-label="Reader card number" />
      <label className="kiosk-pin-field"><span>PIN（可选） / Optional PIN</span><input inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSubmit(); }} placeholder="••••" /></label>
      {error ? <p className="kiosk-error" role="alert"><AlertIcon />{error}</p> : null}
      <Button loading={loading} onClick={onSubmit}>{bilingual("继续", "Continue")}</Button>
      <p className="kiosk-hint">支持读者证、二维码和键盘扫码器<br /><small>Cards, QR codes, and keyboard barcode scanners supported</small></p>
    </div>
  </KioskShell>;
}

function HomeScreen({ user, openLoans, dueSoon, overdue, onNavigate }: { user: string; openLoans: number; dueSoon: number; overdue: number; onNavigate: (screen: Exclude<KioskScreen, "idle" | "identify" | "result">) => void }) {
  const actions: Array<{ screen: Exclude<KioskScreen, "idle" | "identify" | "result">; zh: string; en: string; mark: string }> = [
    { screen: "borrow", zh: "借阅", en: "Borrow", mark: "+" },
    { screen: "return", zh: "归还", en: "Return", mark: "↩" },
    { screen: "renew", zh: "续借", en: "Renew", mark: "↻" },
    { screen: "reserve", zh: "预约", en: "Reserve", mark: "□" },
    { screen: "loans", zh: "我的借阅", en: "My loans", mark: "≡" },
    { screen: "help", zh: "帮助", en: "Help", mark: "?" }
  ];
  return <KioskShell title={{ zh: "你好，", en: "Hello, " }} onBack={undefined}>
    <div className="kiosk-home">
      <div className="kiosk-greeting"><h1>{user}<small>欢迎回来 / Welcome back</small></h1><p>选择一项服务，整个过程不到 30 秒<br /><span>Choose a service. Most tasks take under 30 seconds.</span></p></div>
      <div className="kiosk-summary"><div><strong>{openLoans}</strong><span>借阅中 / Active</span></div><div className={dueSoon ? "is-warn" : ""}><strong>{dueSoon}</strong><span>即将到期 / Due soon</span></div><div className={overdue ? "is-danger" : ""}><strong>{overdue}</strong><span>逾期 / Overdue</span></div></div>
      <div className="kiosk-action-grid">{actions.map((action) => <button key={action.screen} onClick={() => onNavigate(action.screen)}><b>{action.mark}</b><span>{action.zh}</span><small>{action.en}</small></button>)}</div>
    </div>
  </KioskShell>;
}

function KioskShell({ title, onBack, children }: { title: { zh: string; en: string }; onBack: (() => void) | undefined; children: ReactNode }) {
  return <section className="kiosk-shell"><div className="kiosk-shell-heading">{onBack ? <button className="kiosk-back" onClick={onBack}>←</button> : null}<h1>{title.zh}<small>{title.en}</small></h1></div>{children}</section>;
}

function BorrowScreen({ books, scannedBookIds, step, input, setInput, error, onAdd, onRemove, onNext, onConfirm, onBack, busy, loanDays, maxLoans }: { books: Book[]; scannedBookIds: string[]; step: "scan" | "confirm" | "receipt"; input: string; setInput: (value: string) => void; error: string; onAdd: () => void; onRemove: (id: string) => void; onNext: () => void; onConfirm: () => void; onBack: () => void; busy: boolean; loanDays: number; maxLoans: number }) {
  const scanned = books.filter((book) => scannedBookIds.includes(book.id) && book.status === "on_shelf");
  return <KioskShell title={screenCopy.borrow} onBack={onBack}>
    <div className="kiosk-flow">
      <div className="kiosk-stepper"><span className={step === "scan" ? "active" : ""}>1 扫描 / Scan</span><span className={step === "confirm" ? "active" : ""}>2 确认 / Confirm</span><span>3 完成 / Done</span></div>
      {step === "scan" ? <><div className="kiosk-tray"><div className="kiosk-tray-ring">RFID</div><h2>请将图书放在 RFID 托盘上</h2><p>Place books on the tray · 也可手动输入 RFID / ISBN</p><div className="kiosk-manual-row"><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onAdd(); }} placeholder="RFID-000001 / ISBN" /><button onClick={onAdd}>添加 / Add</button></div></div><div className="kiosk-book-list">{scanned.slice(-5).map((book) => <BookCard key={book.id} book={book} onRemove={() => onRemove(book.id)} />)}</div><RuleHints loanDays={loanDays} maxLoans={maxLoans} /></> : <><h2 className="kiosk-subheading">请确认以下借阅 / Confirm these books</h2><div className="kiosk-book-list">{scanned.map((book) => <BookCard key={book.id} book={book} />)}</div><RuleHints loanDays={loanDays} maxLoans={maxLoans} /></>}
      {error ? <p className="kiosk-error" role="alert"><AlertIcon />{error}</p> : null}
      <div className="kiosk-flow-actions"><button onClick={onBack}>取消 / Cancel</button>{step === "scan" ? <Button onClick={onNext} disabled={!scanned.length}>确认借阅 / Review</Button> : <Button loading={busy} onClick={onConfirm}>借阅并开闸 / Borrow & exit</Button>}</div>
    </div>
  </KioskShell>;
}

function BookCard({ book, onRemove }: { book: Book; onRemove?: () => void }) {
  return <article className="kiosk-book-card"><span className="kiosk-spine" style={{ background: book.cover_color }} /><div><strong>{book.title}</strong><span>{book.author} · {book.shelf_location}</span><code>{book.rfid_tag}</code></div>{onRemove ? <button onClick={onRemove} aria-label={`Remove ${book.title}`}><CloseIcon /></button> : <CheckIcon className="kiosk-check" />}</article>;
}

function RuleHints({ loanDays, maxLoans }: { loanDays: number; maxLoans: number }) {
  return <div className="kiosk-rule-hints"><span>最多借阅 {maxLoans} 本 / Max {maxLoans} loans</span><span>期限 {loanDays} 天 / {loanDays} days</span><span>闸机已联动 / Gate linked</span></div>;
}

function ReturnScreen({ loans, finePerDayCents, onReturn, onManualReturn, input, setInput, onBack, busy, error }: { loans: Loan[]; finePerDayCents: number; onReturn: (loan: Loan) => void; onManualReturn: () => void; input: string; setInput: (value: string) => void; onBack: () => void; busy: boolean; error: string }) {
  return <KioskShell title={screenCopy.return} onBack={onBack}><div className="kiosk-flow"><div className="kiosk-tray compact"><div className="kiosk-tray-ring">RFID</div><h2>把要归还的图书放到托盘上</h2><p>Place books to return · 也可手动输入 RFID / ISBN</p><div className="kiosk-manual-row"><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onManualReturn(); }} placeholder="RFID-000001 / ISBN" /><button onClick={onManualReturn}>查找 / Find</button></div></div><div className="kiosk-loan-list">{loans.length ? loans.map((loan) => { const overdueDays = Math.max(0, Math.ceil((Date.now() - new Date(loan.due_at).getTime()) / 86400000)); const fine = Math.round(overdueDays * finePerDayCents / 100); return <article key={loan.id} className="kiosk-loan-card"><div className="kiosk-loan-main"><strong>{loan.book?.title ?? `Book ${loan.book_id}`}</strong><span>{loan.book?.author ?? "Library item"} · 应还 {formatDate(loan.due_at)}</span>{overdueDays ? <em>逾期费用 / Fine: ¥{fine}</em> : null}</div>{loan.status === "overdue" ? <StatusBadge tone="danger" label="逾期 / Overdue" /> : null}<button onClick={() => onReturn(loan)} disabled={busy}>归还 / Return</button></article>; }) : <EmptyKiosk text="暂无可归还图书 / No active loans" />}</div>{error ? <p className="kiosk-error"><AlertIcon />{error}</p> : null}</div></KioskShell>;
}

function RenewScreen({ loans, selected, maxRenewals, loanDays, onSelect, onSubmit, onBack, busy, error }: { loans: Loan[]; selected: string[]; maxRenewals: number; loanDays: number; onSelect: (ids: string[]) => void; onSubmit: () => void; onBack: () => void; busy: boolean; error: string }) {
  return <KioskShell title={screenCopy.renew} onBack={onBack}><div className="kiosk-flow"><p className="kiosk-section-intro">勾选要续借的图书 / Check books to renew</p><div className="kiosk-loan-list">{loans.length ? loans.map((loan) => { const blocked = loan.renew_count >= maxRenewals; return <label key={loan.id} className={`kiosk-loan-card kiosk-checkable ${blocked ? "is-blocked" : ""}`}><input type="checkbox" disabled={blocked} checked={selected.includes(loan.id)} onChange={() => onSelect(selected.includes(loan.id) ? selected.filter((id) => id !== loan.id) : [...selected, loan.id])} /><div className="kiosk-loan-main"><strong>{loan.book?.title ?? `Book ${loan.book_id}`}</strong><span>当前到期 {formatDate(loan.due_at)} · 续借 {loan.renew_count}/{maxRenewals}</span>{blocked ? <em>已达续借上限 / Renewal limit reached</em> : null}</div><span className="kiosk-new-date">{blocked ? "--" : formatDate(new Date(new Date(loan.due_at).getTime() + loanDays * 86400000).toISOString())}</span></label>; }) : <EmptyKiosk text="暂无可续借图书 / No active loans" />}</div>{error ? <p className="kiosk-error"><AlertIcon />{error}</p> : null}<div className="kiosk-flow-actions"><button onClick={onBack}>取消 / Cancel</button><Button loading={busy} onClick={onSubmit}>确认续借 / Renew selected</Button></div></div></KioskShell>;
}

function ReserveScreen({ query, setQuery, results, onSearch, onReserve, onBack, busy }: { query: string; setQuery: (value: string) => void; results: Book[]; onSearch: () => void; onReserve: (book: Book) => void; onBack: () => void; busy: boolean }) {
  return <KioskShell title={screenCopy.reserve} onBack={onBack}><div className="kiosk-flow"><div className="kiosk-search-row"><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} placeholder="书名、拼音或 ISBN / Title, pinyin or ISBN" /><button onClick={onSearch}>搜索 / Search</button></div><div className="kiosk-reserve-list">{results.filter((book) => book.status === "borrowed").map((book) => <article className="kiosk-book-card" key={book.id}><span className="kiosk-spine" style={{ background: book.cover_color }} /><div><strong>{book.title}</strong><span>{book.author} · 已借出 / Borrowed</span></div><button disabled={busy} onClick={() => onReserve(book)}>预约 / Reserve</button></article>)}</div>{!results.length ? <EmptyKiosk text="输入关键词开始搜索 / Search by title or ISBN" /> : null}</div></KioskShell>;
}

function LoansScreen({ loans, onBack }: { loans: Loan[]; onBack: () => void }) {
  return <KioskShell title={screenCopy.loans} onBack={onBack}><div className="kiosk-flow"><div className="kiosk-loan-list">{loans.length ? loans.map((loan) => <article key={loan.id} className="kiosk-loan-card"><div className="kiosk-loan-main"><strong>{loan.book?.title ?? `Book ${loan.book_id}`}</strong><span>{loan.book?.author ?? ""}</span></div><div className={loan.status === "overdue" ? "kiosk-date is-danger" : daysUntil(loan.due_at) <= 7 ? "kiosk-date is-warn" : "kiosk-date"}>{loan.status === "overdue" ? "逾期" : "应还"}<strong>{formatDate(loan.due_at)}</strong>{loan.status === "overdue" ? <small>逾期费用按规则计算</small> : null}</div></article>) : <EmptyKiosk text="暂无借阅记录 / No active loans" />}</div></div></KioskShell>;
}

function HelpScreen({ onCall, onBack, busy }: { onCall: () => void; onBack: () => void; busy: boolean }) {
  return <KioskShell title={screenCopy.help} onBack={onBack}><div className="kiosk-help"><div className="kiosk-help-steps"><div><b>1</b><span>刷卡 / Tap card</span></div><div><b>2</b><span>放书 / Place book</span></div><div><b>3</b><span>确认 / Confirm</span></div></div><p>设备故障或需要人工协助？<br /><small>Device fault or need a person?</small></p><Button loading={busy} onClick={onCall}>呼叫远程支持 / Call remote support</Button></div></KioskShell>;
}

function ResultScreen({ result, onDone }: { result: KioskResult; onDone: () => void }) {
  return <section className="kiosk-result"><div className={`kiosk-result-mark ${result.kind}`}><CheckIcon /></div><h1>{result.title}</h1><p>{result.detail}</p>{result.items?.length ? <div className="kiosk-result-items">{result.items.map((item) => <div key={item.title}><strong>{item.title}</strong><span>{item.dueAt ? `应还 ${formatDate(item.dueAt)}` : item.shelf ?? ""}</span></div>)}</div> : null}<button className="kiosk-start" onClick={onDone}>{bilingual("返回首页", "Back to home")}<span>→</span></button></section>;
}

function EmptyKiosk({ text }: { text: string }) {
  return <div className="kiosk-empty"><BookSpines seed={11} /><p>{text}</p></div>;
}

function DevDrawer({ state, dispatch, onClose, onPlace, onOffline, onScan }: { state: typeof initialKioskState; dispatch: Dispatch<Parameters<typeof kioskReducer>[1]>; onClose: () => void; onPlace: () => void; onOffline: () => void; onScan: () => void }) {
  return <aside className="kiosk-dev-drawer"><div className="kiosk-dev-head"><strong>DEV DRAWER</strong><button onClick={onClose}><CloseIcon /></button></div><p>Simulator controls · hidden in production</p><button onClick={onPlace}>放置模拟图书 / Place book</button><button onClick={onScan}>扫描演示读者 / Scan demo card</button><button onClick={onOffline}>{state.network === "offline" ? "恢复网络 / Go online" : "断开网络 / Go offline"}</button><button onClick={() => dispatch({ type: "RESULT", result: { kind: "warning", title: "闸机测试告警 / Gate alarm test", detail: "已创建模拟门禁事件 / Simulated gate event created." } })}>触发闸机告警 / Trigger gate alarm</button></aside>;
}
