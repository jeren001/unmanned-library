import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import { Button, LangSwitch, SegmentedControl, Skeleton, StatusBadge, ToastProvider, useToast } from "../shared/components";
import { BellIcon } from "../shared/icons";
import { BookSpinesBand } from "../shared/motion";
import { NotFoundPage } from "../shared/NotFoundPage";
import { ApiError, fetchBranches, fetchMe, fetchOpenAlerts, logout, type AlertRow, type Branch, type Role, type SessionUser } from "./adminApi";
import { ErrorPanel, formatDate } from "./adminUi";
import { AdminContext, AdminEventHub, type AdminContextValue } from "./adminContext";
import { CommandPalette, type Command } from "./CommandPalette";
import { BooksPage, CirculationPage, ReadersPage } from "./ListPages";
import { AlertsPage } from "./AlertsPage";
import { DevicesPage } from "./DevicesPage";
import { MaintenancePage } from "./MaintenancePage";
import { OverviewPage, RulesPage } from "./OverviewRules";
import { SimulatorPage } from "./SimulatorPage";
import { TracePage } from "./TracePage";
import { ExportsPage } from "./ExportsPage";
import "./admin.css";

type Theme = "light" | "dark";
type NavItem = { key: string; path: string; roles: Role[]; plate: string };

const NAV: NavItem[] = [
  { key: "overview", path: "", roles: ["librarian", "admin"], plate: "000" },
  { key: "books", path: "books", roles: ["librarian", "admin"], plate: "100" },
  { key: "readers", path: "readers", roles: ["librarian", "admin"], plate: "200" },
  { key: "circulation", path: "circulation", roles: ["librarian", "admin"], plate: "300" },
  { key: "devices", path: "devices", roles: ["librarian", "admin"], plate: "400" },
  { key: "alerts", path: "alerts", roles: ["librarian", "admin"], plate: "500" },
  { key: "maintenance", path: "maintenance", roles: ["librarian", "admin"], plate: "600" },
  { key: "telemetry", path: "telemetry", roles: ["librarian", "admin"], plate: "700" },
  { key: "trace", path: "trace", roles: ["librarian", "admin"], plate: "750" },
  { key: "exports", path: "exports", roles: ["librarian", "admin"], plate: "800" },
  { key: "rules", path: "settings/rules", roles: ["admin"], plate: "900" },
  { key: "simulator", path: "settings/simulator", roles: ["admin"], plate: "950" }
];

const THEME_KEY = "ul-admin-theme";
const CLOCK_DRIFT_MS = 2 * 60_000;

// Loaded on demand so ECharts is only downloaded for the wallboard.
const WallboardPage = lazy(() => import("./wallboard/WallboardPage").then((module) => ({ default: module.WallboardPage })));
const TelemetryPage = lazy(() => import("./TelemetryPage").then((module) => ({ default: module.TelemetryPage })));

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function AdminPage() {
  return (
    <ToastProvider>
      <AdminGate />
    </ToastProvider>
  );
}

/** Route guard: only librarians and admins get the console; readers go to the kiosk. */
function AdminGate() {
  const { t } = useTranslation();
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; user?: SessionUser | null; error?: unknown }>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const fromLogin = Boolean((useLocation().state as { fromLogin?: boolean } | null)?.fromLogin);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetchMe()
      .then((user) => { if (alive) setState({ status: "ready", user }); })
      .catch((error) => {
        if (!alive) return;
        if (error instanceof ApiError && error.status === 401) setState({ status: "ready", user: null });
        else setState({ status: "error", error });
      });
    return () => { alive = false; };
  }, [nonce]);

  if (state.status === "loading") {
    // Straight from the login form the session check takes a moment; keep the screen blank rather than flash a splash.
    if (fromLogin) return <main className="admin-splash" aria-busy="true" />;
    return (
      <main className="admin-splash" aria-busy="true">
        <BookSpinesBand count={24} height={40} className="is-small" />
        <p>{t("admin.loading")}</p>
      </main>
    );
  }
  if (state.status === "error") return <main className="admin-splash"><ErrorPanel error={state.error} onRetry={() => setNonce((value) => value + 1)} /></main>;
  if (!state.user) return <Navigate to="/login" replace />;
  if (state.user.role === "reader") return <Navigate to="/kiosk" replace />;
  return <AdminRoutes user={state.user} />;
}

/** The wallboard is full-bleed (no sidebar); everything else lives in the shell. */
function AdminRoutes({ user }: { user: SessionUser }) {
  const { t } = useTranslation();
  const location = useLocation();
  if (location.pathname.startsWith("/admin/wallboard")) {
    return (
      <Suspense fallback={<main className="admin-splash" data-theme="wallboard"><BookSpinesBand count={24} height={40} className="is-small" /><p>{t("admin.wallboard.loading")}</p></main>}>
        <WallboardPage />
      </Suspense>
    );
  }
  return <AdminShell user={user} />;
}

function RequireRole({ user, roles, children }: { user: SessionUser; roles: Role[]; children: ReactNode }) {
  const { t } = useTranslation();
  const toast = useToast();
  const allowed = roles.includes(user.role);
  const told = useRef(false);
  useEffect(() => {
    if (allowed || told.current) return;
    told.current = true;
    toast({ tone: "info", title: t("admin.forbidden.title"), body: t("admin.forbidden.body") });
  }, [allowed, toast, t]);
  return allowed ? <>{children}</> : <Navigate to="/admin" replace />;
}

function AdminShell({ user }: { user: SessionUser }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [theme, setTheme] = useState<Theme>(readTheme);
  // Signed in just now: fade the console in instead of showing an intermediate screen.
  const [fromLogin] = useState(() => Boolean((location.state as { fromLogin?: boolean } | null)?.fromLogin));
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("all");
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [ring, setRing] = useState(0);
  const [bellOpen, setBellOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const bellRef = useRef<HTMLDivElement>(null);
  const hub = useMemo(() => new AdminEventHub(), []);
  // Only alerts raised after this page opened may toast; older ones live in the bell.
  const openedAt = useRef(Date.now());

  const nav = NAV.filter((item) => item.roles.includes(user.role));

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Theme persistence is a convenience only.
    }
  }, [theme]);

  useEffect(() => {
    void fetchBranches().then(setBranches).catch(() => setBranches([]));
  }, []);

  const refreshAlerts = useCallback(() => {
    void fetchOpenAlerts(branchId).then(setAlerts).catch(() => undefined);
  }, [branchId]);

  useEffect(refreshAlerts, [refreshAlerts]);

  // Live updates: new alerts ring the bell and raise a toast; KPI changes refresh the overview.
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const stream = new EventSource(`/api/stream${branchId === "all" ? "" : `?branchId=${encodeURIComponent(branchId)}`}`, { withCredentials: true });
    const onRaised = (event: MessageEvent<string>) => {
      let payload: { message?: string; severity?: string; duplicate?: boolean; ts?: string } = {};
      try {
        payload = JSON.parse(event.data);
      } catch {
        // Keep the generic toast below.
      }
      refreshAlerts();
      setRefreshKey((value) => value + 1);
      if (payload.duplicate) return;
      if (payload.severity !== "critical" && payload.severity !== "warning") return;
      const raisedAt = Date.parse(payload.ts ?? "");
      // The server no longer replays history to a fresh page; this also guards against old alerts, allowing for clock drift.
      if (Number.isFinite(raisedAt) && raisedAt < openedAt.current - CLOCK_DRIFT_MS) return;
      setRing((value) => value + 1);
      toast({ tone: "alert", title: t("admin.alerts.new", { severity: t(`admin.severity.${payload.severity ?? "warning"}`) }), body: payload.message });
    };
    const onChanged = () => { refreshAlerts(); setRefreshKey((value) => value + 1); };
    const forward = (name: "alert.raised" | "alert.acked" | "alert.resolved" | "device.status_changed" | "kpi.updated") => (event: Event) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse((event as MessageEvent<string>).data);
      } catch {
        // Pages treat a missing payload as "something changed".
      }
      hub.emit(name, payload);
    };
    stream.addEventListener("alert.raised", onRaised as EventListener);
    stream.addEventListener("alert.acked", onChanged);
    stream.addEventListener("alert.resolved", onChanged);
    stream.addEventListener("kpi.updated", onChanged);
    for (const name of ["alert.raised", "alert.acked", "alert.resolved", "device.status_changed", "kpi.updated"] as const) stream.addEventListener(name, forward(name));
    return () => stream.close();
  }, [branchId, refreshAlerts, toast, t, hub]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
      if (event.key === "Escape") setBellOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!bellOpen) return;
    const onDown = (event: MouseEvent) => { if (!bellRef.current?.contains(event.target as Node)) setBellOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [bellOpen]);

  async function signOut() {
    try {
      await logout();
    } catch {
      // The session may already be gone; leave the console either way.
    }
    navigate("/login", { replace: true });
  }

  const context = useMemo<AdminContextValue>(() => ({
    user,
    branches,
    branchId,
    branchName: (id: string) => {
      const branch = branches.find((item) => item.id === id);
      return branch ? (i18n.language === "en" ? branch.name_en : branch.name_zh) : id;
    },
    events: hub
  }), [user, branches, branchId, i18n.language, hub]);

  const current = nav.find((item) => item.path && location.pathname.startsWith(`/admin/${item.path}`)) ?? nav[0];
  const branchName = (branch: Branch) => (i18n.language === "en" ? branch.name_en : branch.name_zh);

  const commands = useMemo<Command[]>(() => [
    ...nav.map((item) => ({ id: `go-${item.key}`, group: t("admin.palette.pages"), label: t(`admin.nav.${item.key}`), hint: item.path ? `/admin/${item.path}` : "/admin", run: () => navigate(item.path ? `/admin/${item.path}` : "/admin") })),
    { id: "go-wallboard", group: t("admin.palette.pages"), label: t("admin.nav.wallboard"), hint: "/admin/wallboard", run: () => navigate("/admin/wallboard") },
    { id: "theme", group: t("admin.palette.actions"), label: theme === "dark" ? t("admin.palette.light") : t("admin.palette.dark"), run: () => setTheme((value) => (value === "dark" ? "light" : "dark")) },
    { id: "lang", group: t("admin.palette.actions"), label: t("admin.palette.lang"), run: () => void i18n.changeLanguage(i18n.language === "en" ? "zh-CN" : "en") },
    { id: "logout", group: t("admin.palette.actions"), label: t("admin.logout"), run: () => void signOut() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [nav.length, theme, i18n.language, t]);

  return (
    <AdminContext.Provider value={context}>
    <div className={`admin-app ${fromLogin ? "is-entering" : ""}`} data-theme={theme}>
      <aside className="admin-sidebar" aria-label={t("admin.navigation")}>
        <Link className="admin-brand" to="/login">
          <b>{t("app.name")}</b>
          <span>{t("admin.console")}</span>
        </Link>
        <nav>
          {nav.map((item) => (
            <NavLink key={item.key} to={item.path ? `/admin/${item.path}` : "/admin"} end={item.path === ""} className="admin-drawer-link">
              <span className="admin-drawer-plate mono" aria-hidden="true">{item.plate}</span>
              <span>{t(`admin.nav.${item.key}`)}</span>
              <i aria-hidden="true" />
            </NavLink>
          ))}
        </nav>
        <NavLink to="/admin/wallboard" className="admin-drawer-link admin-wallboard-link">
          <span className="admin-drawer-plate mono" aria-hidden="true">WB</span>
          <span>{t("admin.nav.wallboard")}</span>
          <i aria-hidden="true" />
        </NavLink>
        <div className="admin-sidebar-user">
          <span className="admin-avatar" aria-hidden="true">{user.name.slice(0, 1)}</span>
          <div>
            <b>{user.name}</b>
            <small>{t(`admin.role.${user.role}`)}</small>
          </div>
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <b className="admin-topbar-title">{t(`admin.nav.${current.key}`)}</b>
          <label className="admin-branch">
            <span className="qa-sr-only">{t("admin.branch")}</span>
            <select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="all">{t("admin.allBranches")}</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branchName(branch)}</option>)}
            </select>
          </label>
          <button type="button" className="admin-search-trigger" onClick={() => setPaletteOpen(true)}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" /><path d="M14 14l4 4" /></svg>
            <span>{t("admin.search")}</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="admin-bell-wrap" ref={bellRef}>
            <button
              type="button"
              className="admin-bell"
              aria-label={t("admin.alerts.label", { count: alerts.length })}
              aria-expanded={bellOpen}
              onClick={() => setBellOpen((value) => !value)}
            >
              <BellIcon key={ring} className={ring ? "is-ringing" : undefined} />
              {alerts.length ? <em className="mono">{alerts.length > 99 ? "99+" : alerts.length}</em> : null}
            </button>
            {bellOpen ? (
              <div className="admin-bell-panel" role="region" aria-label={t("admin.alerts.title")}>
                <h3>{t("admin.alerts.title")} <span className="mono">{alerts.length}</span></h3>
                {alerts.length ? (
                  <ul>
                    {alerts.map((alert) => (
                      <li key={alert.id}>
                        <StatusBadge tone={alert.severity === "critical" ? "danger" : alert.severity === "warning" ? "warn" : "info"} label={t(`admin.severity.${alert.severity}`)} />
                        <span>{alert.message}</span>
                        <time className="mono">{formatDate(alert.created_at)}</time>
                      </li>
                    ))}
                  </ul>
                ) : <p>{t("admin.overview.noAlerts")}</p>}
                <NavLink className="admin-bell-all" to="/admin/alerts" onClick={() => setBellOpen(false)}>{t("admin.alerts.viewAll")} →</NavLink>
              </div>
            ) : null}
          </div>
          <div className="admin-topbar-controls">
            <LangSwitch />
            <SegmentedControl
              label={t("theme.label")}
              items={[t("theme.light"), t("theme.dark")]}
              value={theme === "dark" ? t("theme.dark") : t("theme.light")}
              onChange={(label) => setTheme(label === t("theme.dark") ? "dark" : "light")}
            />
            <Button variant="ghost" onClick={() => void signOut()}>Log out / 退出</Button>
          </div>
        </header>

        <main className="admin-content">
          <Routes>
            <Route index element={<OverviewPage branchId={branchId} refreshKey={refreshKey} />} />
            <Route path="books" element={<BooksPage branchId={branchId} />} />
            <Route path="readers" element={<ReadersPage />} />
            <Route path="circulation" element={<CirculationPage branchId={branchId} />} />
            <Route path="settings" element={<Navigate to="/admin/settings/rules" replace />} />
            <Route path="settings/rules" element={<RequireRole user={user} roles={["admin"]}><RulesPage /></RequireRole>} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="maintenance" element={<MaintenancePage />} />
            <Route path="telemetry" element={<Suspense fallback={<div className="admin-telemetry-chart is-loading"><Skeleton lines={6} /></div>}><TelemetryPage /></Suspense>} />
            <Route path="trace" element={<TracePage />} />
            <Route path="exports" element={<ExportsPage />} />
            <Route path="settings/simulator" element={<RequireRole user={user} roles={["admin"]}><SimulatorPage /></RequireRole>} />
            <Route path="*" element={<NotFoundPage embedded />} />
          </Routes>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        searchCommand={(text) => ({ id: "search-books", group: t("admin.palette.search"), label: t("admin.palette.searchBooks", { text }), run: () => navigate(`/admin/books?q=${encodeURIComponent(text)}`) })}
      />
    </div>
    </AdminContext.Provider>
  );
}
