import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button, LangSwitch, SegmentedControl, Tabs, TextField } from "../shared/components";
import { AlertIcon } from "../shared/icons";
import { DEMO_MODE } from "../shared/demoMode";
import { DemoReaderPicker } from "../shared/DemoReaderPicker";
import { BookSpinesBand, PageTurn, prefersReducedMotion } from "../shared/motion";
import { cardLogin, cardLoginErrorMessage, cardScan, destinationFor, fetchServerDemoMode, LoginError, loginErrorMessage, passwordLogin, type Role, type SessionUser } from "./loginApi";
import "./login.css";

type Theme = "light" | "dark";
type StaffRole = Exclude<Role, "reader">;
type ReaderPhase = "idle" | "reading" | "accepted" | "rejected";
/** Messages are kept as i18n keys and translated on render, so they follow a later language switch. */
type Message = { key: string; values?: Record<string, number> };

const THEME_KEY = "ul-login-theme";

// Prefill buttons shown only in demo mode (VITE_DEMO_MODE); mirrored in docs/DEMO_ACCOUNTS.md.
const demoAccounts: Record<StaffRole, { account: string; password: string }> = {
  librarian: { account: "librarian", password: "librarian123" },
  admin: { account: "admin", password: "admin123" }
};

/**
 * Demo accounts and the demo PIN are shown only when the build is a demo build (VITE_DEMO_MODE, so production
 * bundles drop them) and the server is in demo mode too (DEMO_MODE, the same flag as /card-scan).
 */
function useDemoHints() {
  const [serverDemo, setServerDemo] = useState(false);
  useEffect(() => {
    if (!DEMO_MODE) return;
    let active = true;
    void fetchServerDemoMode().then((value) => {
      if (active) setServerDemo(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return DEMO_MODE && serverDemo;
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, prefersReducedMotion() ? 0 : ms));

function initialTheme(): Theme {
  const param = new URLSearchParams(window.location.search).get("theme");
  if (param === "dark" || param === "light") return param;
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [role, setRole] = useState<Role>("reader");
  const [switchedTab, setSwitchedTab] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Theme persistence is a convenience only.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  // Readers land on kiosk Home already identified (the kiosk reads `reader`); staff go straight to the console.
  const onSuccess = (user: SessionUser) => {
    navigate(destinationFor(user.role), { replace: true, state: user.role === "reader" ? { reader: user } : { fromLogin: true } });
  };

  return (
    <main className="login-page" data-theme={theme}>
      <header className="login-bar">
        <div className="login-bar-title">
          <b>{t("app.name")}</b>
          <span>{t("login.branch")}</span>
        </div>
        <div className="login-bar-controls">
          <LangSwitch />
          <SegmentedControl
            label={t("theme.label")}
            items={[t("theme.light"), t("theme.dark")]}
            value={theme === "dark" ? t("theme.dark") : t("theme.light")}
            onChange={(label) => setTheme(label === t("theme.dark") ? "dark" : "light")}
          />
        </div>
      </header>
      <BookSpinesBand className="login-band" />

      <div className="login-body">
        <Tabs
          idPrefix="login"
          label={t("login.tabs.label")}
          items={[
            { value: "reader", label: t("login.tabs.reader") },
            { value: "librarian", label: t("login.tabs.librarian") },
            { value: "admin", label: t("login.tabs.admin") }
          ]}
          value={role}
          onChange={(value) => {
            setSwitchedTab(true);
            setRole(value as Role);
          }}
        />
        <section className="login-panel" role="tabpanel" id={`login-panel-${role}`} aria-labelledby={`login-tab-${role}`}>
          <PageTurn turnKey={role}>
            {role === "reader" ? <ReaderLogin focusOnMount={!switchedTab} onSuccess={onSuccess} /> : <StaffLogin key={role} role={role} onSuccess={onSuccess} />}
          </PageTurn>
        </section>
      </div>
    </main>
  );
}

function isTextEntry(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function ReaderLogin({ focusOnMount, onSuccess }: { focusOnMount: boolean; onSuccess: (user: SessionUser) => void }) {
  const { t } = useTranslation();
  const demoHints = useDemoHints();
  const inputRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const [cardNumber, setCardNumber] = useState("");
  const [pin, setPin] = useState("");
  const [phase, setPhase] = useState<ReaderPhase>("idle");
  // `field` says which input the message belongs to (the PIN field only exists once a card number is typed).
  const [error, setError] = useState<(Message & { field: "card" | "pin" }) | null>(null);
  // A demo-list scan fills in the card number too, but needs no PIN.
  const [scanning, setScanning] = useState(false);
  const showPin = cardNumber.trim() !== "" && !scanning;
  const busy = phase === "reading" || phase === "accepted";

  useEffect(() => {
    // Card scanners act as keyboards: start with the field focused so a scan lands in it.
    if (focusOnMount) inputRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // If focus is elsewhere (e.g. on a tab), route scanner keystrokes into the card field.
    const onKey = (event: KeyboardEvent) => {
      const input = inputRef.current;
      if (!input || input.disabled || isTextEntry(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length !== 1 || event.key === " ") return;
      event.preventDefault();
      setCardNumber((value) => value + event.key);
      setPhase((value) => (value === "rejected" ? "idle" : value));
      input.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (phase !== "rejected") return;
    if (error?.field === "pin") pinRef.current?.focus();
    else inputRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /** `pin === null` is a card reader scan (demo list), which needs no PIN; a typed card number always does. */
  async function signIn(number: string, pinValue: string | null) {
    if (busy) return;
    setError(null);
    if (!number.trim()) {
      setError({ key: "login.error.cardRequired", field: "card" });
      inputRef.current?.focus();
      return;
    }
    if (pinValue !== null && !pinValue) {
      setError({ key: "login.error.pinRequired", field: "pin" });
      pinRef.current?.focus();
      return;
    }
    setScanning(pinValue === null);
    setPhase("reading");
    // The card slides into the slot while the request runs; both must finish.
    const [result] = await Promise.allSettled([pinValue === null ? cardScan(number) : cardLogin(number, pinValue), wait(950)]);
    if (result.status === "rejected") {
      setPin("");
      setScanning(false);
      setError({ ...cardLoginErrorMessage(result.reason), field: pinValue === null ? "card" : "pin" });
      setPhase("rejected");
      return;
    }
    setPhase("accepted");
    onSuccess(result.value);
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    // Enter in the card field moves on to the PIN; Enter in the PIN field signs in.
    if (showPin && !pin && document.activeElement !== pinRef.current) {
      pinRef.current?.focus();
      return;
    }
    void signIn(cardNumber, pin);
  };

  return (
    <div className="login-reader">
      <div className={`login-stage is-${phase}`} aria-hidden="true">
        <span className="login-wave" />
        <span className="login-wave" />
        <span className="login-wave" />
        <div className="login-card">
          <div className="login-card-head">
            <span>{t("login.card.title")}</span>
            <span className="mono">{t("login.card.titleEn")}</span>
          </div>
          <div className="login-card-photo" />
          <div className="login-card-no mono">{cardNumber.trim() || "R-····"}</div>
          <div className="login-card-line" />
          <div className="login-card-line is-short" />
          <div className="login-card-barcode">{Array.from({ length: 15 }, (_, index) => <i key={index} />)}</div>
        </div>
        <div className="login-slot"><span className="login-led" /></div>
        <div className="login-slot-cover" />
      </div>

      <div className="login-copy">
        <h1>{t("login.reader.title")}</h1>
        <p className="login-muted">{t("login.reader.body")}</p>
        <form className="login-card-form" onSubmit={onSubmit} noValidate>
          <TextField
            ref={inputRef}
            label={t("login.reader.cardLabel")}
            hint={error?.field === "card" ? undefined : t("login.reader.cardHint")}
            error={error?.field === "card" ? t(error.key, error.values) : undefined}
            mono
            name="cardNumber"
            autoComplete="off"
            spellCheck={false}
            value={cardNumber}
            disabled={busy}
            onChange={(event) => {
              setCardNumber(event.target.value);
              if (phase === "rejected") setPhase("idle");
            }}
          />
          {showPin ? (
            <TextField
              ref={pinRef}
              label={t("login.reader.pinLabel")}
              hint={demoHints && error?.field !== "pin" ? t("login.reader.pinHint") : undefined}
              error={error?.field === "pin" ? t(error.key, error.values) : undefined}
              type="password"
              name="pin"
              autoComplete="new-password"
              value={pin}
              disabled={busy}
              onChange={(event) => {
                setPin(event.target.value);
                if (phase === "rejected") setPhase("idle");
              }}
            />
          ) : null}
          <div className="login-actions">
            <Button type="submit" loading={phase === "reading"}>{t("login.reader.submit")}</Button>
            {/* Signs in as a chosen demo reader, so it is a demo-mode convenience only (renders nothing otherwise). */}
            <DemoReaderPicker
              disabled={busy}
              onPick={(card) => {
                setCardNumber(card);
                void signIn(card, null);
              }}
            />
          </div>
        </form>
      </div>
    </div>
  );
}

function StaffLogin({ role, onSuccess }: { role: StaffRole; onSuccess: (user: SessionUser) => void }) {
  const { t } = useTranslation();
  const demoHints = useDemoHints();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ account?: string; password?: string }>({});
  const [error, setError] = useState<{ message: Message; locked: boolean } | null>(null);
  const [lockedAccount, setLockedAccount] = useState<string | null>(null);
  const isLocked = lockedAccount !== null && lockedAccount === account.trim().toLowerCase();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const missing = {
      account: account.trim() ? undefined : "login.error.accountRequired",
      password: password ? undefined : "login.error.passwordRequired"
    };
    setFieldErrors(missing);
    setError(null);
    if (missing.account || missing.password || isLocked) return;

    setLoading(true);
    try {
      const user = await passwordLogin(role, account, password, remember);
      onSuccess(user);
    } catch (caught) {
      const locked = caught instanceof LoginError && caught.code === "ACCOUNT_LOCKED";
      if (locked) setLockedAccount(account.trim().toLowerCase());
      setError({ message: loginErrorMessage(caught), locked });
      setPassword("");
      setLoading(false);
    }
  }

  return (
    <div className="login-staff">
      <h1>{t(`login.${role}.title`)}</h1>
      <p className="login-muted">{t(`login.${role}.body`)}</p>
      <form className="login-staff-form" onSubmit={onSubmit} noValidate>
        <TextField
          label={t("login.staff.account")}
          name="username"
          autoComplete="off"
          placeholder={t("login.staff.accountPlaceholder")}
          value={account}
          error={fieldErrors.account && t(fieldErrors.account)}
          onChange={(event) => setAccount(event.target.value)}
        />
        <div className="login-password">
          <TextField
            label={t("login.staff.password")}
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={password}
            error={fieldErrors.password && t(fieldErrors.password)}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="button" className="login-reveal" aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>
            {showPassword ? t("login.staff.hide") : t("login.staff.show")}
          </button>
        </div>
        <label className="login-remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>{t("login.staff.remember")}</span>
        </label>

        {error ? (
          <div className={`login-alert ${error.locked ? "is-locked" : ""}`} role="alert">
            <AlertIcon />
            <div>
              <strong>{error.locked ? t("login.error.lockedTitle") : t("login.error.title")}</strong>
              <p>{t(error.message.key, error.message.values)}</p>
            </div>
          </div>
        ) : null}

        <Button type="submit" loading={loading} disabled={isLocked}>{t("login.staff.submit")}</Button>
      </form>

      {demoHints ? (
        <p className="login-demo">
          <span>{t("login.demo")}</span>
          <button
            type="button"
            onClick={() => {
              setAccount(demoAccounts[role].account);
              setPassword(demoAccounts[role].password);
              setFieldErrors({});
              setError(null);
            }}
          >
            {demoAccounts[role].account} / {demoAccounts[role].password}
          </button>
        </p>
      ) : null}
    </div>
  );
}
