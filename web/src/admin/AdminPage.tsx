import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate } from "react-router";
import { LangSwitch, Logo, SegmentedControl } from "../shared/components";
import { BellIcon, ChevronIcon, CloseIcon, InfoIcon } from "../shared/icons";
import "./admin.css";

type Role = "reader" | "librarian" | "admin";
type ThemeMode = "light" | "dark";
type User = { id: string; role: Role; name: string; account: string };
type Branch = { id: string; code: string; name_zh: string; name_en: string };
type Overview = { branches: number; books: number; readers: number; devicesOnline: number; activeLoans: number; openAlerts: number };

const navGroups = [
  { key: "overview", items: [{ key: "overview", icon: "◈" }] },
  { key: "catalogue", items: [{ key: "books", icon: "▤" }] },
  { key: "readers", items: [{ key: "readers", icon: "◎" }] },
  { key: "circulation", items: [{ key: "circulation", icon: "↔" }] },
  { key: "devices", items: [{ key: "devices", icon: "⌁" }] },
  { key: "alerts", items: [{ key: "alerts", icon: "!" }] },
  { key: "telemetry", items: [{ key: "telemetry", icon: "⌁" }] },
  { key: "maintenance", items: [{ key: "maintenance", icon: "＋" }] },
  { key: "traceability", items: [{ key: "traceability", icon: "⌗" }] },
  { key: "exports", items: [{ key: "exports", icon: "↓" }] },
  { key: "settings", items: [{ key: "settings", icon: "⚙" }] }
] as const;

function api<T>(path: string, init?: RequestInit) {
  return fetch(path, { credentials: "include", ...init }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(body.error ?? body.code ?? "REQUEST_FAILED"));
    return body as T;
  });
}

function routeKey(pathname: string) {
  return pathname.split("/")[2] || "overview";
}

export function AdminPage() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => localStorage.getItem("ul-admin-theme") === "dark" ? "dark" : "light");
  const [branchId, setBranchId] = useState("all");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [alertCount, setAlertCount] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [search, setSearch] = useState("");

  const key = routeKey(location.pathname);
  const isSettings = key === "settings";

  useEffect(() => {
    void api<{ user: User | null }>("/api/auth/me")
      .then(({ user: nextUser }) => {
        if (!nextUser || nextUser.role === "reader") {
          navigate(nextUser?.role === "reader" ? "/kiosk" : "/login", { replace: true });
          return;
        }
        setUser(nextUser);
      })
      .catch(() => navigate("/login", { replace: true }))
      .finally(() => setLoadingAuth(false));
  }, [navigate]);

  useEffect(() => {
    if (!user) return;
    void api<{ data: Branch[] }>("/api/branches?limit=100").then(({ data }) => setBranches(data)).catch(() => setBranches([]));
    void refreshOverview();
    void refreshAlerts();
    const stream = new EventSource(`/api/stream${branchId === "all" ? "" : `?branchId=${encodeURIComponent(branchId)}`}`);
    const refresh = () => { void refreshOverview(); void refreshAlerts(); };
    stream.addEventListener("alert.raised", refresh);
    stream.addEventListener("alert.acked", refresh);
    stream.addEventListener("alert.resolved", refresh);
    return () => stream.close();
  }, [user, branchId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setUserMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => localStorage.setItem("ul-admin-theme", theme), [theme]);

  async function refreshOverview() {
    const query = branchId === "all" ? "" : `?branchId=${encodeURIComponent(branchId)}`;
    try {
      const response = await api<{ data: Overview }>(`/api/stats/overview${query}`);
      setOverview(response.data);
    } catch {
      setOverview(null);
    }
  }

  async function refreshAlerts() {
    const query = new URLSearchParams({ status: "open", limit: "200" });
    if (branchId !== "all") query.set("branchId", branchId);
    try {
      const response = await api<{ data: Array<unknown> }>(`/api/alerts?${query.toString()}`);
      setAlertCount(response.data.length);
    } catch {
      setAlertCount(0);
    }
  }

  function go(nextKey: string) {
    if (nextKey === "settings" && user?.role === "librarian") {
      navigate("/admin");
      return;
    }
    navigate(nextKey === "overview" ? "/admin" : `/admin/${nextKey}`);
    setSearchOpen(false);
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    navigate("/login", { replace: true });
  }

  const visibleGroups = useMemo(() => navGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.key !== "settings" || user?.role === "admin")
  })).filter((group) => group.items.length > 0), [user?.role]);

  const searchResults = visibleGroups.flatMap((group) => group.items).filter((item) => {
    const label = t(`admin.nav.${item.key}`).toLowerCase();
    return !search.trim() || label.includes(search.toLowerCase());
  });

  if (loadingAuth || !user) return <main className="admin-loading">{t("admin.loading")}</main>;
  if (isSettings && user.role === "librarian") return <Navigate to="/admin" replace />;

  const pageTitle = isSettings && user.role === "librarian" ? t("admin.nav.overview") : t(`admin.nav.${key}`, { defaultValue: t("admin.nav.overview") });
  const displayName = i18n.language === "zh-CN" ? user.name : user.account;

  return (
    <div className={`admin-app ${collapsed ? "is-collapsed" : ""}`} data-theme={theme}>
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <Logo />
          <div className="admin-brand-copy"><strong>{t("app.name")}</strong><span>{t("admin.console")}</span></div>
        </div>
        <nav className="admin-nav" aria-label={t("admin.navigation")}>
          {visibleGroups.map((group) => (
            <div className="admin-nav-group" key={group.key}>
              <p>{t(`admin.group.${group.key}`)}</p>
              {group.items.map((item) => (
                <button className={key === item.key ? "is-active" : ""} key={item.key} onClick={() => go(item.key)} title={collapsed ? t(`admin.nav.${item.key}`) : undefined}>
                  <span className="admin-nav-icon" aria-hidden="true">{item.icon}</span>
                  <span>{t(`admin.nav.${item.key}`)}</span>
                  {item.key === "alerts" && alertCount > 0 ? <em>{alertCount}</em> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <button className="admin-collapse" onClick={() => setCollapsed((value) => !value)} aria-label={t("admin.collapse")}>
          <span>{collapsed ? "»" : "«"}</span><span>{t("admin.collapse")}</span>
        </button>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <div className="admin-topbar-left">
            <label className="admin-branch-select" htmlFor="admin-branch">
              <span>{t("admin.branch")}</span>
              <select id="admin-branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                <option value="all">{t("admin.allBranches")}</option>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{i18n.language === "zh-CN" ? branch.name_zh : branch.name_en}</option>)}
              </select>
              <ChevronIcon />
            </label>
            <button className="admin-search-trigger" onClick={() => setSearchOpen(true)}>
              <span className="admin-search-glyph">⌕</span><span>{t("admin.search")}</span><kbd>Ctrl K</kbd>
            </button>
          </div>
          <div className="admin-topbar-actions">
            <button className="admin-icon-button" onClick={() => go("alerts")} aria-label={t("admin.alerts")}>
              <BellIcon />
              {alertCount > 0 ? <span>{alertCount}</span> : null}
            </button>
            <LangSwitch />
            <SegmentedControl items={[t("theme.light"), t("theme.dark")]} value={theme === "light" ? t("theme.light") : t("theme.dark")} onChange={(label) => setTheme(label === t("theme.dark") ? "dark" : "light")} />
            <div className="admin-user-wrap">
              <button className="admin-user-button" onClick={() => setUserMenuOpen((value) => !value)}>
                <span className="admin-avatar">{displayName.slice(0, 1)}</span>
                <span><strong>{displayName}</strong><small>{t(`admin.role.${user.role}`)}</small></span>
                <ChevronIcon />
              </button>
              {userMenuOpen ? <div className="admin-user-menu"><button onClick={() => void logout()}>{t("admin.logout")}</button></div> : null}
            </div>
          </div>
        </header>

        <main className="admin-content">
          <div className="admin-breadcrumbs"><button onClick={() => go("overview")}>{t("admin.nav.overview")}</button><span>/</span><strong>{pageTitle}</strong></div>
          {key === "overview" ? <OverviewPage overview={overview} t={t} /> : <PlaceholderPage title={pageTitle} t={t} />}
        </main>
      </div>

      {searchOpen ? <div className="admin-overlay" onMouseDown={() => setSearchOpen(false)}>
        <section className="admin-command-palette" role="dialog" aria-modal="true" aria-label={t("admin.commandPalette")} onMouseDown={(event) => event.stopPropagation()}>
          <div className="admin-command-heading"><strong>{t("admin.commandPalette")}</strong><button onClick={() => setSearchOpen(false)} aria-label={t("admin.close")}><CloseIcon /></button></div>
          <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("admin.searchPlaceholder")} />
          <div className="admin-command-list">{searchResults.length ? searchResults.map((item) => <button key={item.key} onClick={() => go(item.key)}><span>{item.icon}</span>{t(`admin.nav.${item.key}`)}<small>↵</small></button>) : <p>{t("admin.noResults")}</p>}</div>
          <footer><span>{t("admin.navigate")}</span><kbd>Esc</kbd><span>{t("admin.close")}</span></footer>
        </section>
      </div> : null}
    </div>
  );
}

function OverviewPage({ overview, t }: { overview: Overview | null; t: (key: string) => string }) {
  const cards = [
    ["branches", "admin.kpi.branches", "admin.kpi.branchesHint"],
    ["books", "admin.kpi.books", "admin.kpi.booksHint"],
    ["activeLoans", "admin.kpi.activeLoans", "admin.kpi.activeLoansHint"],
    ["openAlerts", "admin.kpi.openAlerts", "admin.kpi.openAlertsHint"]
  ] as const;
  return (
    <section className="admin-overview">
      <div className="admin-page-heading"><div><p>{t("admin.eyebrow")}</p><h1>{t("admin.overviewTitle")}</h1><span>{t("admin.overviewSubtitle")}</span></div><span className="admin-live-mark"><i />{t("admin.live")}</span></div>
      <div className="admin-kpi-grid">
        {cards.map(([field, label, hint]) => <article className="admin-kpi-card" key={field}><span>{t(label)}</span><strong>{overview ? overview[field] : "—"}</strong><small>{t(hint)}</small></article>)}
      </div>
      <div className="admin-overview-note"><InfoIcon /><div><strong>{t("admin.overviewNoteTitle")}</strong><p>{t("admin.overviewNote")}</p></div></div>
    </section>
  );
}

function PlaceholderPage({ title, t }: { title: string; t: (key: string) => string }) {
  return <section className="admin-placeholder"><div className="admin-placeholder-spines" aria-hidden="true"><span /><span /><span /><span /><span /></div><h1>{title}</h1><p>{t("admin.placeholder")}</p></section>;
}
