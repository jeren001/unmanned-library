import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BookStatus, Column } from "./components";
import {
  Button,
  Card,
  CatalogCard,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  LangSwitch,
  Logo,
  SegmentedControl,
  Skeleton,
  StatCard,
  StatusBadge,
  Stepper,
  Tabs,
  TextField,
  Toast,
  ToastProvider,
  useToast
} from "./components";
import { ShelfRouteMap } from "./ShelfRouteMap";
import { BookmarkRibbon, BookSpinesBand, CatalogDrawer, CountUp, PageTurn, StaggerList } from "./motion";
import "./design.css";

type DemoBook = { id: string; callNumber: string; title: string; author: string; location: string; status: BookStatus };

// Sample catalogue records (data, not UI copy).
const BOOKS: DemoBook[] = [
  { id: "1", callNumber: "TP311.5/S4", title: "软件体系结构", author: "Mary Shaw", location: "A-3-2", status: "in" },
  { id: "2", callNumber: "TP316/T2", title: "现代操作系统", author: "Tanenbaum", location: "A-3-5", status: "borrowed" },
  { id: "3", callNumber: "TP311.13/S5", title: "数据库系统概念", author: "Silberschatz", location: "A-4-1", status: "in" },
  { id: "4", callNumber: "TP301.6/C7", title: "算法导论", author: "Cormen", location: "B-1-3", status: "overdue" },
  { id: "5", callNumber: "I247.5/L8", title: "三体", author: "刘慈欣", location: "C-2-4", status: "repair" },
  { id: "6", callNumber: "TP312/K6", title: "C程序设计语言", author: "Kernighan", location: "B-2-2", status: "in" }
];

const SWATCHES = ["burgundy", "burgundy-deep", "rose", "blush", "wood", "cream", "paper", "ink", "line", "success"];
const SEMANTIC = ["bg", "surface", "line", "text", "accent", "blush", "success"];

export function DesignPage() {
  return (
    <ToastProvider>
      <Showcase />
    </ToastProvider>
  );
}

function Showcase() {
  const { t } = useTranslation();
  const toast = useToast();
  const [dark, setDark] = useState(() => new URLSearchParams(window.location.search).get("mode") === "dark");
  const [tab, setTab] = useState("reader");
  const [filter, setFilter] = useState<"all" | BookStatus>("all");
  const [selected, setSelected] = useState<DemoBook | null>(null);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [replay, setReplay] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [ribbon, setRibbon] = useState(0);
  const [loading, setLoading] = useState(false);
  const [shelf, setShelf] = useState("EAST-B-17");
  const [kpi, setKpi] = useState({ shelf: 42, loans: 128, overdue: 9, online: 96 });

  const steps = [t("design.step.place"), t("design.step.confirm"), t("design.step.receipt")];
  const rows = BOOKS.filter((book) => filter === "all" || book.status === filter);
  const columns: Column<DemoBook>[] = [
    { key: "callNumber", header: t("catalog.callNumber"), mono: true },
    { key: "title", header: t("catalog.title") },
    { key: "author", header: t("catalog.author") },
    { key: "location", header: t("catalog.location"), mono: true },
    { key: "status", header: t("catalog.status"), render: (book) => <StatusBadge status={book.status} /> }
  ];

  const go = (next: number) => {
    setDirection(next > step ? "forward" : "back");
    setStep(Math.max(0, Math.min(steps.length - 1, next)));
  };

  const fakeSubmit = () => {
    setLoading(true);
    window.setTimeout(() => {
      setLoading(false);
      toast({ tone: "success", title: t("design.toast.savedTitle"), body: t("design.toast.savedBody") });
    }, 1200);
  };

  return (
    <main className="qa-showcase" data-theme={dark ? "dark" : "light"}>
      <header className="qa-showcase-top">
        <div>
          <Logo />
          <div>
            <h1>{t("design.title")}</h1>
            <p>{t("design.subtitle")}</p>
          </div>
        </div>
        <div className="qa-showcase-controls" aria-label={t("design.controls")}>
          <LangSwitch />
          <SegmentedControl
            label={t("theme.label")}
            items={[t("theme.light"), t("theme.wallboard")]}
            value={dark ? t("theme.wallboard") : t("theme.light")}
            onChange={(label) => setDark(label === t("theme.wallboard"))}
          />
        </div>
      </header>
      <BookSpinesBand />

      <section className="qa-showcase-grid">
        <Card title={t("design.section.tokens")} className="is-wide">
          <div className="qa-swatches">
            {SWATCHES.map((name) => (
              <figure key={name}>
                <span style={{ background: `var(--${name})` }} />
                <figcaption><b>{name}</b><code>--{name}</code></figcaption>
              </figure>
            ))}
          </div>
          <p className="qa-showcase-note">{t("design.tokens.semantic")}</p>
          <div className="qa-swatches is-semantic">
            {SEMANTIC.map((name) => (
              <figure key={name}>
                <span style={{ background: `var(--${name})` }} />
                <figcaption><b>{name}</b><code>--{name}</code></figcaption>
              </figure>
            ))}
          </div>
          <div className="qa-type-sample">
            <p className="is-serif">{t("design.type.serif")}</p>
            <p>{t("design.type.sans")}</p>
            <p className="mono">TP311.5/S4 · RFID-000001 · 0123456789</p>
          </div>
        </Card>

        <Card title={t("design.section.buttons")}>
          <div className="qa-row">
            <Button onClick={fakeSubmit} loading={loading}>{loading ? t("action.loading") : t("action.confirm")}</Button>
            <Button variant="ghost">{t("action.cancel")}</Button>
            <Button loading>{t("action.loading")}</Button>
            <Button disabled>{t("action.disabled")}</Button>
          </div>
          <div className="qa-row">
            <Button size="lg">{t("design.kioskButton")}</Button>
          </div>
        </Card>

        <Card title={t("design.section.fields")}>
          <div className="qa-form-grid">
            <TextField label={t("field.reader")} placeholder={t("field.reader.placeholder")} hint={t("field.reader.hint")} mono />
            <TextField label={t("field.password")} type="password" placeholder="••••••" error={t("field.password.error")} />
          </div>
        </Card>

        <Card title={t("design.section.tabs")} className="is-wide">
          <div className="qa-folder">
            <Tabs
              label={t("design.tabs.label")}
              items={[
                { value: "reader", label: t("design.tabs.reader") },
                { value: "librarian", label: t("design.tabs.librarian") },
                { value: "admin", label: t("design.tabs.admin") }
              ]}
              value={tab}
              onChange={setTab}
            />
            <div className="qa-folder-panel" role="tabpanel">
              <PageTurn turnKey={tab}>
                <p className="qa-folder-title">{t(`design.tabs.${tab}Title`)}</p>
                <p className="qa-showcase-note">{t(`design.tabs.${tab}Body`)}</p>
              </PageTurn>
            </div>
          </div>
        </Card>

        <Card title={t("design.section.status")}>
          <div className="qa-row">
            {(["in", "borrowed", "overdue", "repair"] as const).map((status) => <StatusBadge key={status} status={status} />)}
          </div>
          <div className="qa-row">
            <StatusBadge tone="ok" label={t("status.ok")} />
            <StatusBadge tone="warn" label={t("status.warn")} />
            <StatusBadge tone="danger" label={t("status.danger")} />
            <StatusBadge tone="info" label={t("status.info")} />
            <StatusBadge tone="offline" label={t("status.offline")} />
          </div>
        </Card>

        <Card title={t("design.section.catalogCard")}>
          <CatalogCard callNumber="TP311.5/S4" title="《软件体系结构》" author="Mary Shaw" location={t("design.sampleLocation")} status="in" />
        </Card>

        <Card title={t("design.section.table")} className="is-wide qa-table-demo">
          <div className="qa-row" role="group" aria-label={t("design.table.filter")}>
            {(["all", "in", "borrowed", "overdue", "repair"] as const).map((value) => (
              <button key={value} type="button" className="qa-chip" aria-pressed={filter === value} onClick={() => { setFilter(value); setSelected(null); }}>
                {value === "all" ? t("design.table.all") : t(`book.status.${value}`)}
              </button>
            ))}
          </div>
          <DataTable columns={columns} rows={rows} rowKey={(book) => book.id} selectedKey={selected?.id} onRowClick={setSelected} caption={t("design.section.table")} />
          <p className="qa-showcase-note">{t("design.table.hint")}</p>
          <Drawer contained open={Boolean(selected)} onClose={() => setSelected(null)} title={selected ? `《${selected.title}》` : ""}>
            {selected ? (
              <dl>
                <dt>{t("catalog.callNumber")}</dt><dd className="mono">{selected.callNumber}</dd>
                <dt>{t("catalog.author")}</dt><dd>{selected.author}</dd>
                <dt>{t("catalog.location")}</dt><dd className="mono">{selected.location}</dd>
                <dt>{t("catalog.status")}</dt><dd><StatusBadge status={selected.status} /></dd>
              </dl>
            ) : null}
          </Drawer>
        </Card>

        <Card title={t("design.section.tableStates")}>
          <DataTable columns={columns.slice(0, 3)} rows={[]} rowKey={(book) => book.id} />
          <DataTable columns={columns.slice(0, 3)} rows={[]} rowKey={(book) => book.id} state="loading" />
          <DataTable columns={columns.slice(0, 3)} rows={[]} rowKey={(book) => book.id} state="error" />
        </Card>

        <Card title={t("design.section.feedback")}>
          <div className="qa-row">
            <Button variant="ghost" onClick={() => toast({ tone: "alert", title: t("design.toast.alarmTitle"), body: t("design.toast.alarmBody") })}>{t("design.toast.alarm")}</Button>
            <Button variant="ghost" onClick={() => toast({ tone: "info", title: t("design.toast.infoTitle") })}>{t("design.toast.info")}</Button>
          </div>
          <Toast tone="success" title={t("design.toast.savedTitle")} body={t("design.toast.savedBody")} />
          <Dialog
            title={t("dialog.title")}
            body={t("dialog.body")}
            actions={<><Button variant="ghost">{t("action.cancel")}</Button><Button>{t("action.confirm")}</Button></>}
          />
        </Card>

        <Card title={t("design.section.stepper")} className="is-wide">
          <Stepper steps={steps} current={step} />
          <div className="qa-page-stage">
            <PageTurn turnKey={step} direction={direction}>
              <p className="qa-folder-title">{steps[step]}</p>
              <p className="qa-showcase-note">{t(`design.step.body${step}`)}</p>
            </PageTurn>
          </div>
          <div className="qa-row">
            <Button variant="ghost" disabled={step === 0} onClick={() => go(step - 1)}>{t("action.back")}</Button>
            <Button disabled={step === steps.length - 1} onClick={() => go(step + 1)}>{t("action.next")}</Button>
          </div>
        </Card>

        <Card title={t("design.section.empty")}>
          <EmptyState title={t("empty.title")} body={t("empty.body")} action={<Button variant="ghost">{t("empty.action")}</Button>} />
          <Skeleton lines={3} />
        </Card>

        <Card title={t("design.section.countUp")}>
          <div className="qa-kpis">
            <StatCard title={t("design.kpi.shelf")} value={<CountUp value={kpi.shelf} />} />
            <StatCard title={t("design.kpi.loans")} value={<CountUp value={kpi.loans} />} />
            <StatCard title={t("design.kpi.overdue")} value={<CountUp value={kpi.overdue} />} />
            <StatCard title={t("design.kpi.online")} value={<CountUp value={kpi.online} suffix="%" />} />
          </div>
          <Button variant="ghost" onClick={() => setKpi((value) => ({ ...value, loans: value.loans + 7, overdue: Math.max(0, value.overdue - 1) }))}>{t("design.kpi.update")}</Button>
        </Card>

        <Card title={t("design.section.stagger")}>
          <StaggerList as="ul" replayKey={replay} className="qa-loan-list" delay={100} step={100}>
            {BOOKS.slice(0, 4).map((book) => (
              <li key={book.id}><span>《{book.title}》</span><StatusBadge status={book.status} /></li>
            ))}
          </StaggerList>
          <Button variant="ghost" onClick={() => setReplay((value) => value + 1)}>{t("action.replay")}</Button>
        </Card>

        <Card title={t("design.section.catalogDrawer")}>
          <CatalogDrawer open={drawerOpen} label="TP311">
            <CatalogCard callNumber="TP311.5/S4" title="《软件体系结构》" author="Mary Shaw" location={t("design.sampleLocation")} />
          </CatalogDrawer>
          <div className="qa-row">
            <Button variant="ghost" onClick={() => setDrawerOpen((value) => !value)}>{drawerOpen ? t("design.drawer.close") : t("design.drawer.open")}</Button>
          </div>
        </Card>

        <Card title={t("design.section.ribbon")}>
          <div className="qa-ribbon-stage">
            <BookmarkRibbon key={ribbon} />
            <p className="qa-folder-title">{t("design.ribbon.title")}</p>
            <p className="qa-showcase-note">{t("design.ribbon.body")}</p>
          </div>
          <Button variant="ghost" onClick={() => setRibbon((value) => value + 1)}>{t("action.replay")}</Button>
        </Card>

        <Card title={t("design.section.shelfMap")}>
          <ShelfRouteMap location={shelf} />
          <div className="qa-row">
            {["EAST-B-17", "EAST-G-05", "EAST-D-38"].map((value) => (
              <button key={value} type="button" className="qa-chip mono" aria-pressed={shelf === value} onClick={() => setShelf(value)}>{value}</button>
            ))}
          </div>
          <p className="qa-showcase-note">{t("design.shelfMap.hint")}</p>
        </Card>

        <Card title={t("design.section.spines")} className="is-wide">
          <BookSpinesBand key={replay} count={60} height={64} />
          <p className="qa-showcase-note">{t("design.spines.hint")}</p>
        </Card>
      </section>
    </main>
  );
}
