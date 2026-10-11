import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Button, CatalogCard, Drawer, Skeleton, StatusBadge, Timeline, type BookStatus, type Column, type TimelineItem } from "../shared/components";
import {
  fetchBookHistory, fetchReaderHistory, getBook, getReader, listPage, loanEvents,
  type BookRow, type HistoryEvent, type LoanRow, type ReaderRow
} from "./adminApi";
import { ErrorPanel, FilterChips, formatDate, ListView, PageHeading, SearchBox, useDebounced, usePagedList } from "./adminUi";

type T = (key: string, options?: Record<string, unknown>) => string;

/* ---------- Status badges ---------- */

const BOOK_STATUS: Record<BookRow["status"], BookStatus | null> = { on_shelf: "in", borrowed: "borrowed", repair: "repair", lost: null };
const LOAN_STATUS: Record<LoanRow["status"], BookStatus | null> = { active: "borrowed", overdue: "overdue", returned: "in", lost: null };

export function BookBadge({ status }: { status: BookRow["status"] }) {
  const { t } = useTranslation();
  const mapped = BOOK_STATUS[status];
  return mapped ? <StatusBadge status={mapped} label={t(`admin.bookStatus.${status}`)} /> : <StatusBadge tone="danger" label={t("admin.bookStatus.lost")} />;
}

export function LoanBadge({ status }: { status: LoanRow["status"] }) {
  const { t } = useTranslation();
  const mapped = LOAN_STATUS[status];
  return mapped ? <StatusBadge status={mapped} label={t(`admin.loanStatus.${status}`)} /> : <StatusBadge tone="danger" label={t("admin.loanStatus.lost")} />;
}

function ReaderBadge({ reader }: { reader: ReaderRow }) {
  const { t } = useTranslation();
  if (reader.locked_until && new Date(reader.locked_until).getTime() > Date.now()) return <StatusBadge tone="warn" label={t("admin.readerStatus.locked")} />;
  return reader.status === "active" ? <StatusBadge tone="ok" label={t("admin.readerStatus.active")} /> : <StatusBadge tone="danger" label={t("admin.readerStatus.suspended")} />;
}

function callNumberOf(t: T, book: BookRow) {
  return book.call_number ? { value: book.call_number, label: t("catalog.callNumber") } : { value: book.isbn, label: "ISBN" };
}

/** Resolves a book title or reader name from a loan's id (cached), showing the id until loaded. */
export function LookupName({ kind, id }: { kind: "book" | "reader"; id: string }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setName(null);
    const lookup = kind === "book" ? getBook(id).then((book) => book?.title ?? null) : getReader(id).then((reader) => reader?.display_name ?? null);
    void lookup.then((value) => { if (alive) setName(value); });
    return () => { alive = false; };
  }, [kind, id]);
  return name ? <>{kind === "book" ? `《${name}》` : name}</> : <span className="mono admin-muted">{id}</span>;
}

function historyItem(t: T, event: HistoryEvent, index: number, who?: "book" | "reader", targetId?: string): TimelineItem {
  const tone = event.kind === "returned" || event.kind === "acquired" ? "success" : event.kind === "overdue" || event.kind === "lost" ? "danger" : "accent";
  const detail = who === "reader" && event.userId ? <LookupName kind="reader" id={event.userId} /> : who === "book" && targetId ? <LookupName kind="book" id={targetId} /> : undefined;
  return { id: `${event.loanId ?? "book"}-${event.kind}-${index}`, at: event.at, title: t(`admin.history.${event.kind}`), detail, tone };
}

/** Drawer body section that loads a history and shows designed loading/error/empty states. */
function HistorySection<E>({ load, deps, render }: { load: () => Promise<E[]>; deps: unknown[]; render: (events: E[]) => TimelineItem[] }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; events: E[]; error?: unknown }>({ status: "loading", events: [] });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ status: "loading", events: [] });
    load().then((events) => { if (alive) setState({ status: "ready", events }); }).catch((error) => { if (alive) setState({ status: "error", events: [], error }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return (
    <section className="admin-history">
      <h4>{t("admin.history.title")}</h4>
      {state.status === "loading" ? <Skeleton lines={3} /> : state.status === "error"
        ? <ErrorPanel error={state.error} onRetry={() => setNonce((value) => value + 1)} />
        : <Timeline items={render(state.events)} emptyText={t("admin.history.empty")} />}
    </section>
  );
}

/** Keeps the last selection rendered while the drawer slides out. */
function useDrawerSelection<R>() {
  const [selected, setSelected] = useState<R | null>(null);
  const [open, setOpen] = useState(false);
  return { selected, open, select: (row: R) => { setSelected(row); setOpen(true); }, close: () => setOpen(false) };
}

/* ---------- Books ---------- */

type BookFilter = "all" | BookRow["status"];

export function BooksPage({ branchId }: { branchId: string }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [status, setStatus] = useState<BookFilter>("all");
  const q = useDebounced(query.trim());
  const list = usePagedList<BookRow>((page) => listPage("/api/books", page), { q, status, branchId });
  const drawer = useDrawerSelection<BookRow>();

  useEffect(() => {
    const fromPalette = params.get("q");
    if (fromPalette !== null) setQuery(fromPalette);
  }, [params]);

  const columns: Column<BookRow>[] = [
    { key: "call", header: `${t("catalog.callNumber")} / ISBN`, mono: true, render: (book) => callNumberOf(t, book).value },
    { key: "title", header: t("catalog.title"), render: (book) => <span className="admin-title-cell"><i style={{ background: book.cover_color }} aria-hidden="true" />{book.title}</span> },
    { key: "author", header: t("catalog.author") },
    { key: "shelf_location", header: t("catalog.location"), mono: true },
    { key: "status", header: t("catalog.status"), render: (book) => <BookBadge status={book.status} /> }
  ];

  return (
    <>
      <PageHeading eyebrow="CATALOGUE / BOOKS" title={t("admin.nav.books")} subtitle={t("admin.books.subtitle")} />
      <div className="admin-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder={t("admin.books.search")} />
        <FilterChips
          label={t("admin.filter")}
          value={status}
          onChange={setStatus}
          options={(["all", "on_shelf", "borrowed", "repair", "lost"] as const).map((value) => ({ value, label: value === "all" ? t("admin.all") : t(`admin.bookStatus.${value}`) }))}
        />
      </div>
      <ListView
        list={list}
        columns={columns}
        rowKey={(book) => book.id}
        caption={t("admin.nav.books")}
        selectedKey={drawer.open ? drawer.selected?.id : null}
        onRowClick={drawer.select}
        emptyTitle={q || status !== "all" ? t("admin.empty.filteredTitle") : t("admin.books.emptyTitle")}
        emptyBody={q || status !== "all" ? t("admin.empty.filteredBody") : t("admin.books.emptyBody")}
        emptyAction={q || status !== "all" ? <Button variant="ghost" onClick={() => { setQuery(""); setStatus("all"); }}>{t("admin.empty.clear")}</Button> : undefined}
      />
      <Drawer open={drawer.open} onClose={drawer.close} title={drawer.selected ? `《${drawer.selected.title}》` : ""}>
        {drawer.selected ? <BookDetail book={drawer.selected} /> : null}
      </Drawer>
    </>
  );
}

function BookDetail({ book }: { book: BookRow }) {
  const { t } = useTranslation();
  const code = callNumberOf(t, book);
  return (
    <div className="admin-detail">
      <CatalogCard callNumber={code.value} callNumberLabel={code.label} title={book.title} author={book.author} location={book.shelf_location}>
        <dl className="admin-detail-extra">
          <dt>{t("admin.books.category")}</dt><dd className="mono">{book.category}</dd>
          <dt>{t("admin.books.edition")}</dt><dd>{book.edition}</dd>
          <dt>RFID</dt><dd className="mono">{book.rfid_tag}</dd>
          <dt>{t("catalog.status")}</dt><dd><BookBadge status={book.status} /></dd>
        </dl>
      </CatalogCard>
      <HistorySection load={() => fetchBookHistory(book)} deps={[book.id]} render={(events) => events.map((event, index) => historyItem(t, event, index, "reader"))} />
    </div>
  );
}

/* ---------- Readers ---------- */

type ReaderFilter = "all" | "active" | "suspended";

export function ReadersPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ReaderFilter>("all");
  const q = useDebounced(query.trim());
  // /api/readers lists the users table; staff accounts are filtered out here.
  const list = usePagedList<ReaderRow>(
    (page) => listPage<ReaderRow>("/api/readers", page).then((result) => ({ ...result, rows: result.rows.filter((row) => !row.role || row.role === "reader") })),
    { q, status }
  );
  const drawer = useDrawerSelection<ReaderRow>();

  const columns: Column<ReaderRow>[] = [
    { key: "card_no", header: t("admin.readers.card"), mono: true, render: (reader) => reader.card_no ?? "—" },
    { key: "display_name", header: t("admin.readers.name") },
    { key: "username", header: t("admin.readers.account"), mono: true },
    { key: "email", header: t("admin.readers.email"), render: (reader) => reader.email ?? "—" },
    { key: "deposit", header: t("admin.readers.deposit"), mono: true, render: (reader) => `¥${(reader.deposit_cents / 100).toFixed(2)}` },
    { key: "status", header: t("catalog.status"), render: (reader) => <ReaderBadge reader={reader} /> }
  ];

  return (
    <>
      <PageHeading eyebrow="READERS" title={t("admin.nav.readers")} subtitle={t("admin.readers.subtitle")} />
      <div className="admin-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder={t("admin.readers.search")} />
        <FilterChips
          label={t("admin.filter")}
          value={status}
          onChange={setStatus}
          options={(["all", "active", "suspended"] as const).map((value) => ({ value, label: value === "all" ? t("admin.all") : t(`admin.readerStatus.${value}`) }))}
        />
      </div>
      <ListView
        list={list}
        columns={columns}
        rowKey={(reader) => reader.id}
        caption={t("admin.nav.readers")}
        selectedKey={drawer.open ? drawer.selected?.id : null}
        onRowClick={drawer.select}
        emptyTitle={q || status !== "all" ? t("admin.empty.filteredTitle") : t("admin.readers.emptyTitle")}
        emptyBody={q || status !== "all" ? t("admin.empty.filteredBody") : t("admin.readers.emptyBody")}
        emptyAction={q || status !== "all" ? <Button variant="ghost" onClick={() => { setQuery(""); setStatus("all"); }}>{t("admin.empty.clear")}</Button> : undefined}
      />
      <Drawer open={drawer.open} onClose={drawer.close} title={drawer.selected?.display_name ?? ""}>
        {drawer.selected ? (
          <div className="admin-detail">
            <CatalogCard callNumber={drawer.selected.card_no ?? "—"} callNumberLabel={t("admin.readers.card")} title={drawer.selected.display_name}>
              <dl className="admin-detail-extra">
                <dt>{t("admin.readers.account")}</dt><dd className="mono">{drawer.selected.username}</dd>
                <dt>{t("admin.readers.email")}</dt><dd>{drawer.selected.email ?? "—"}</dd>
                <dt>{t("admin.readers.student")}</dt><dd className="mono">{drawer.selected.student_no ?? "—"}</dd>
                <dt>{t("admin.readers.since")}</dt><dd className="mono">{formatDate(drawer.selected.created_at)}</dd>
                <dt>{t("catalog.status")}</dt><dd><ReaderBadge reader={drawer.selected} /></dd>
              </dl>
            </CatalogCard>
            <HistorySection
              load={() => fetchReaderHistory(drawer.selected!.id)}
              deps={[drawer.selected.id]}
              render={(events) => events.map((event, index) => historyItem(t, event, index, "book", event.bookId))}
            />
          </div>
        ) : null}
      </Drawer>
    </>
  );
}

/* ---------- Circulation ---------- */

type LoanFilter = "all" | LoanRow["status"];

export function CirculationPage({ branchId }: { branchId: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LoanFilter>("all");
  const list = usePagedList<LoanRow>((page) => listPage("/api/loans", page), { status, branchId });
  const drawer = useDrawerSelection<LoanRow>();

  const columns: Column<LoanRow>[] = [
    { key: "book", header: t("catalog.title"), render: (loan) => <LookupName kind="book" id={loan.book_id} /> },
    { key: "reader", header: t("admin.readers.name"), render: (loan) => <LookupName kind="reader" id={loan.user_id} /> },
    { key: "borrowed_at", header: t("admin.loans.borrowed"), mono: true, render: (loan) => formatDate(loan.borrowed_at) },
    { key: "due_at", header: t("admin.loans.due"), mono: true, render: (loan) => <span className={loan.status === "overdue" ? "admin-overdue" : undefined}>{formatDate(loan.due_at)}</span> },
    { key: "renew_count", header: t("admin.loans.renewals"), mono: true, render: (loan) => String(loan.renew_count) },
    { key: "status", header: t("catalog.status"), render: (loan) => <LoanBadge status={loan.status} /> }
  ];

  return (
    <>
      <PageHeading eyebrow="CIRCULATION" title={t("admin.nav.circulation")} subtitle={t("admin.loans.subtitle")} />
      <div className="admin-toolbar">
        <FilterChips
          label={t("admin.filter")}
          value={status}
          onChange={setStatus}
          options={(["all", "active", "overdue", "returned", "lost"] as const).map((value) => ({ value, label: value === "all" ? t("admin.all") : t(`admin.loanStatus.${value}`) }))}
        />
      </div>
      <ListView
        list={list}
        columns={columns}
        rowKey={(loan) => loan.id}
        caption={t("admin.nav.circulation")}
        selectedKey={drawer.open ? drawer.selected?.id : null}
        onRowClick={drawer.select}
        emptyTitle={status !== "all" ? t("admin.empty.filteredTitle") : t("admin.loans.emptyTitle")}
        emptyBody={status !== "all" ? t("admin.empty.filteredBody") : t("admin.loans.emptyBody")}
        emptyAction={status !== "all" ? <Button variant="ghost" onClick={() => setStatus("all")}>{t("admin.empty.clear")}</Button> : undefined}
      />
      <Drawer open={drawer.open} onClose={drawer.close} title={t("admin.loans.detail")}>
        {drawer.selected ? <LoanDetail loan={drawer.selected} /> : null}
      </Drawer>
    </>
  );
}

function LoanDetail({ loan }: { loan: LoanRow }) {
  const { t } = useTranslation();
  const [book, setBook] = useState<BookRow | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setBook(undefined);
    void getBook(loan.book_id).then((value) => { if (alive) setBook(value); });
    return () => { alive = false; };
  }, [loan.book_id]);

  return (
    <div className="admin-detail">
      {book === undefined ? <Skeleton lines={4} /> : book ? (
        <CatalogCard callNumber={callNumberOf(t, book).value} callNumberLabel={callNumberOf(t, book).label} title={book.title} author={book.author} location={book.shelf_location}>
          <dl className="admin-detail-extra">
            <dt>{t("admin.readers.name")}</dt><dd><LookupName kind="reader" id={loan.user_id} /></dd>
            <dt>{t("admin.loans.due")}</dt><dd className="mono">{formatDate(loan.due_at)}</dd>
            <dt>{t("admin.loans.renewals")}</dt><dd className="mono">{loan.renew_count}</dd>
            <dt>{t("catalog.status")}</dt><dd><LoanBadge status={loan.status} /></dd>
          </dl>
        </CatalogCard>
      ) : <p className="admin-muted">{t("admin.loans.bookMissing")}</p>}
      <section className="admin-history">
        <h4>{t("admin.history.title")}</h4>
        <Timeline items={[...loanEvents(loan)].reverse().map((event, index) => historyItem(t, event, index))} />
      </section>
    </div>
  );
}
