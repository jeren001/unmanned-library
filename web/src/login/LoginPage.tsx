import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button, LangSwitch, Logo, SegmentedControl, StatusBadge, ThemeSwitch } from "../shared/components";
import { CloseIcon } from "../shared/icons";
import "./login.css";

type Role = "reader" | "librarian" | "admin";
type ThemeMode = "light" | "dark" | "kiosk";

type PublicStats = {
  branchesLive: number;
  devicesOnline: number;
  loansToday: number;
  branchNetwork: "connected" | "offline";
  version: string;
};

const demoStats: PublicStats = {
  branchesLive: 18,
  devicesOnline: 247,
  loansToday: 1326,
  branchNetwork: "connected",
  version: "v0.1.0"
};

const roleOptions: Array<{ role: Role; label: string; helperZh: string; helperEn: string; accountZh: string; accountEn: string }> = [
  {
    role: "reader",
    label: "读者 Reader",
    helperZh: "进入自助借还与个人借阅记录。",
    helperEn: "Opens the kiosk flow and personal loans.",
    accountZh: "读者证号",
    accountEn: "Reader card no."
  },
  {
    role: "librarian",
    label: "馆员 Librarian",
    helperZh: "进入设备、馆藏与借还管理。",
    helperEn: "Opens device, catalogue, and circulation work.",
    accountZh: "邮箱",
    accountEn: "Email"
  },
  {
    role: "admin",
    label: "管理员 Admin",
    helperZh: "进入系统配置、审计与大屏管理。",
    helperEn: "Opens configuration, audit, and wallboard tools.",
    accountZh: "用户名",
    accountEn: "Username"
  }
];

const demoAccounts: Record<Role, { account: string; password: string }> = {
  reader: { account: "R-2048", password: "reader123" },
  librarian: { account: "librarian@library.local", password: "librarian123" },
  admin: { account: "admin", password: "admin123" }
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function LoginPage() {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const param = new URLSearchParams(window.location.search).get("theme");
    return param === "dark" ? "dark" : "light";
  });
  const [role, setRole] = useState<Role>("reader");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<PublicStats>(demoStats);
  const [scanOpen, setScanOpen] = useState(false);
  const [cardNumber, setCardNumber] = useState("");
  const [scanError, setScanError] = useState("");
  const [scanLoading, setScanLoading] = useState(false);

  const lang = i18n.language === "en" ? "en" : "zh";
  const activeRole = useMemo(() => roleOptions.find((option) => option.role === role) ?? roleOptions[0], [role]);
  const landingPath = role === "reader" ? "/kiosk" : "/admin";

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/public/stats", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("stats unavailable"))))
      .then((data: PublicStats) => setStats(data))
      .catch(() => setStats(demoStats));
    return () => controller.abort();
  }, []);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!account.trim() || !password) {
      setError(lang === "zh" ? "请填写账号和密码。" : "Enter account and password.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, account, password, remember })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(mapError(body.error, lang, body.attemptsRemaining));
      }
      navigate(landingPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : mapError("INVALID_CREDENTIALS", lang));
    } finally {
      setLoading(false);
    }
  }

  async function submitCardLogin(number = cardNumber) {
    setScanError("");
    if (!number.trim()) {
      setScanError(lang === "zh" ? "请输入或扫描读者证号。" : "Enter or scan a reader card.");
      return;
    }

    setScanLoading(true);
    try {
      const response = await fetch("/api/auth/card-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardNumber: number })
      });
      if (!response.ok) throw new Error(mapError("INVALID_CARD", lang));
      navigate("/kiosk");
    } catch (err) {
      setScanError(err instanceof Error ? err.message : mapError("INVALID_CARD", lang));
    } finally {
      setScanLoading(false);
    }
  }

  function fillDemo(nextRole: Role) {
    setRole(nextRole);
    setAccount(demoAccounts[nextRole].account);
    setPassword(demoAccounts[nextRole].password);
    setError("");
  }

  return (
    <main className="login-page" data-theme={theme === "dark" ? "dark" : "light"}>
      <div className="login-top-controls" aria-label={lang === "zh" ? "页面设置" : "Page settings"}>
        <LangSwitch />
        <ThemeSwitch mode={theme} onModeChange={(mode) => setTheme(mode === "kiosk" ? "light" : mode)} />
      </div>

      <section className="login-brand-panel" aria-label={lang === "zh" ? "产品概览" : "Product overview"}>
        <div className="login-brand-content">
          <div className="login-brand-mark">
            <Logo />
            <div>
              <strong>无人值守图书馆</strong>
              <span>Unmanned Library</span>
            </div>
          </div>

          <div className="login-copy">
            <p>QUIET ARCHIVE ACCESS</p>
            <h1>
              <span>24 小时，无人也有序。</span>
              <span>Open all hours. Quietly in order.</span>
            </h1>
          </div>

          <dl className="login-live-facts">
            <div>
              <dt>LIVE BRANCHES</dt>
              <dd>{formatNumber(stats.branchesLive)}</dd>
            </div>
            <div>
              <dt>DEVICES ONLINE</dt>
              <dd>{formatNumber(stats.devicesOnline)}</dd>
            </div>
            <div>
              <dt>LOANS TODAY</dt>
              <dd>{formatNumber(stats.loansToday)}</dd>
            </div>
          </dl>
        </div>
        <BookSpinesScene />
      </section>

      <section className="login-form-panel" aria-label={lang === "zh" ? "登录" : "Login"}>
        <div className="login-form-wrap">
          <div className="login-form-heading">
            <p>{lang === "zh" ? "身份认证" : "Identity access"}</p>
            <h2>{lang === "zh" ? "登录 / Log in" : "Log in / 登录"}</h2>
            <span>{lang === "zh" ? activeRole.helperZh : activeRole.helperEn}</span>
          </div>

          <form className="login-form" onSubmit={submitLogin} noValidate>
            <SegmentedControl items={roleOptions.map((option) => option.label)} value={activeRole.label} onChange={(label) => {
              const next = roleOptions.find((option) => option.label === label);
              if (next) {
                setRole(next.role);
                setError("");
              }
            }} />

            <label className="login-field" htmlFor="login-account">
              <span>{lang === "zh" ? activeRole.accountZh : activeRole.accountEn}</span>
              <input
                id="login-account"
                autoComplete={role === "reader" ? "username" : "email"}
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                placeholder={role === "reader" ? "R-2048" : role === "librarian" ? "librarian@library.local" : "admin"}
                aria-invalid={Boolean(error && !account.trim())}
              />
            </label>

            <label className="login-field" htmlFor="login-password">
              <span>{lang === "zh" ? "密码" : "Password"}</span>
              <div className="login-password-row">
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={Boolean(error && !password)}
                />
                <button type="button" onClick={() => setShowPassword((value) => !value)}>
                  {showPassword ? (lang === "zh" ? "隐藏" : "Hide") : (lang === "zh" ? "显示" : "Show")}
                </button>
              </div>
            </label>

            <div className="login-options">
              <label>
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                <span>{lang === "zh" ? "记住我" : "Remember me"}</span>
              </label>
              <span>{lang === "zh" ? `将进入 ${landingPath}` : `Lands at ${landingPath}`}</span>
            </div>

            {error ? <p className="login-error" role="alert">{error}</p> : null}

            <Button loading={loading} type="submit">{lang === "zh" ? "登录 / Log in" : "Log in / 登录"}</Button>
            <Button type="button" variant="secondary" onClick={() => setScanOpen(true)}>
              {lang === "zh" ? "刷读者证 / Scan reader card" : "Scan reader card / 刷读者证"}
            </Button>
          </form>

          {!import.meta.env.PROD ? (
            <details className="login-demo">
              <summary>{lang === "zh" ? "Demo accounts" : "Demo accounts"}</summary>
              <div>
                {roleOptions.map((option) => (
                  <button key={option.role} type="button" onClick={() => fillDemo(option.role)}>
                    {option.label}
                  </button>
                ))}
              </div>
            </details>
          ) : null}
        </div>

        <footer className="login-footer">
          <span>{stats.version}</span>
          <StatusBadge tone={stats.branchNetwork === "connected" ? "ok" : "offline"} label={`Branch network: ${stats.branchNetwork}`} />
        </footer>
      </section>

      {scanOpen ? (
        <div className="login-dialog-backdrop" role="presentation">
          <section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="scan-title">
            <button className="login-dialog-close" type="button" aria-label={lang === "zh" ? "关闭" : "Close"} onClick={() => setScanOpen(false)}>
              <CloseIcon />
            </button>
            <h2 id="scan-title">{lang === "zh" ? "刷读者证" : "Scan reader card"}</h2>
            <p>{lang === "zh" ? "输入、粘贴读者证号，或使用模拟刷卡。" : "Type, paste, or simulate a reader-card scan."}</p>
            <label className="login-field" htmlFor="card-number">
              <span>{lang === "zh" ? "读者证号" : "Reader card"}</span>
              <input id="card-number" value={cardNumber} onChange={(event) => setCardNumber(event.target.value)} placeholder="20240001" autoFocus />
            </label>
            {scanError ? <p className="login-error" role="alert">{scanError}</p> : null}
            <div className="login-dialog-actions">
              <Button type="button" variant="secondary" onClick={() => {
                setCardNumber("20240001");
                void submitCardLogin("20240001");
              }}>
                {lang === "zh" ? "模拟刷卡" : "Simulate scan"}
              </Button>
              <Button type="button" loading={scanLoading} onClick={() => void submitCardLogin()}>
                {lang === "zh" ? "直接进入" : "Enter"}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function mapError(code: string, lang: "zh" | "en", attemptsRemaining?: number) {
  if (code === "ACCOUNT_LOCKED") return lang === "zh" ? "账号连续错误 5 次，已暂时锁定。" : "Account is temporarily locked after 5 failed attempts.";
  if (code === "INVALID_CARD") return lang === "zh" ? "未识别该读者证，请核对后再试。" : "Reader card was not recognized.";
  if (code === "RATE_LIMITED") return lang === "zh" ? "尝试次数过多，请稍后再试。" : "Too many attempts. Please wait a minute.";
  if (attemptsRemaining !== undefined) {
    return lang === "zh" ? `账号或密码不正确，还可尝试 ${attemptsRemaining} 次。` : `Account or password is incorrect. ${attemptsRemaining} attempts remaining.`;
  }
  return lang === "zh" ? "账号或密码不正确。" : "Account or password is incorrect.";
}

function BookSpinesScene() {
  const bars = Array.from({ length: 44 }, (_, index) => {
    const height = 58 + ((index * 37) % 142);
    const width = [12, 18, 10, 24, 14][index % 5];
    const lit = index % 11 === 2 || index % 17 === 5;
    return { height, width, lit, delay: `${(index % 9) * 180}ms` };
  });

  let x = 0;
  return (
    <svg className="login-spines" viewBox="0 0 920 330" preserveAspectRatio="none" role="img" aria-label="Book spines showing live branch activity">
      <defs>
        <linearGradient id="spineShimmer" x1="0" x2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.14" />
          <stop offset="0.48" stopColor="currentColor" stopOpacity="0.34" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <rect x="0" y="290" width="920" height="3" />
      {bars.map((bar, index) => {
        const currentX = x + 14;
        x += bar.width + 8;
        return (
          <g key={index} className={bar.lit ? "is-lit" : undefined} style={{ animationDelay: bar.delay }}>
            <rect x={currentX} y={290 - bar.height} width={bar.width} height={bar.height} rx="3" />
            <rect x={currentX + Math.max(3, bar.width / 2 - 1)} y={298 - bar.height} width="1.5" height={Math.max(24, bar.height - 22)} rx="1" />
          </g>
        );
      })}
    </svg>
  );
}
