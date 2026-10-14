import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CountUp, StaggerList } from "../shared/motion";
import type { Book, KioskScreen, Loan } from "./kioskState";
import { daysLeft, overdueDays } from "./kioskUi";
import "./home.css";

/*
 * Kiosk home after sign-in, as an electronic catalogue (docs/reference/library-ux-motion.html §2):
 * a catalogue search, four service tiles that rise in, and "My loans" with due badges.
 * Unlike the other kiosk screens it shows one language at a time, following the UI language.
 */

const DUE_SOON_DAYS = 7;
const SEARCH_DELAY_MS = 300;

type Service = "borrow" | "return" | "renew" | "reserve";
const SERVICES: Service[] = ["borrow", "return", "renew", "reserve"];

type Due = { tone: "late" | "soon" | "ok"; days: number };

function dueOf(loan: Loan): Due {
  const late = overdueDays(loan);
  if (loan.status === "overdue" || late > 0) return { tone: "late", days: late };
  const left = Math.max(0, daysLeft(loan));
  return { tone: left <= DUE_SOON_DAYS ? "soon" : "ok", days: left };
}

type SearchState = { status: "idle" | "loading" | "done"; query: string; results: Book[] };

export function KioskHome({ user, loans, onNavigate, onSearch, onReserve }: {
  user: string;
  loans: Loan[];
  onNavigate: (screen: Exclude<KioskScreen, "idle" | "identify" | "result">) => void;
  /** Catalogue search; resolves with matching books. */
  onSearch: (query: string) => Promise<Book[]>;
  /** Opens the reserve flow for a book that is on loan. */
  onReserve: (book: Book) => void;
}) {
  const { t } = useTranslation();
  const name = t(`login.userName.${user}`, { defaultValue: user });

  const sorted = useMemo(() => [...loans].sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime()), [loans]);
  const dues = sorted.map(dueOf);
  const dueSoon = dues.filter((due) => due.tone === "soon").length;
  const overdue = dues.filter((due) => due.tone === "late").length;

  return (
    <section className="kiosk-catalog" aria-labelledby="kiosk-home-title">
      <header className="kiosk-catalog-head">
        <h1 id="kiosk-home-title">{t("kiosk.home.greeting", { name })}</h1>
        <p>{t("kiosk.home.hint")}</p>
      </header>

      <CatalogSearch onSearch={onSearch} onReserve={onReserve} />

      <div className="kiosk-catalog-grid">
        <StaggerList className="kiosk-services" step={70} delay={50}>
          {SERVICES.map((service) => (
            <button key={service} type="button" className={`kiosk-service is-${service}`} data-service={service} onClick={() => onNavigate(service)}>
              <b>{t(`kiosk.home.service.${service}`)}</b>
              <span>{t(`kiosk.home.service.${service}Hint`)}</span>
            </button>
          ))}
        </StaggerList>

        <aside className="kiosk-my-loans" aria-labelledby="kiosk-my-loans-title">
          <div className="kiosk-my-loans-head">
            <h2 id="kiosk-my-loans-title">{t("kiosk.home.loans.title")} · <CountUp value={loans.length} duration={700} /></h2>
            <button type="button" onClick={() => onNavigate("loans")}>{t("kiosk.home.loans.all")}</button>
          </div>
          <div className="kiosk-my-loans-stats">
            <span className={dueSoon ? "is-soon" : ""}><CountUp value={dueSoon} duration={700} /> {t("kiosk.home.loans.dueSoon")}</span>
            <span className={overdue ? "is-late" : ""}><CountUp value={overdue} duration={700} /> {t("kiosk.home.loans.overdue")}</span>
          </div>
          {sorted.length ? (
            <StaggerList as="ul" className="kiosk-my-loans-list" delay={350} step={100}>
              {sorted.slice(0, 5).map((loan, index) => {
                const due = dues[index];
                return (
                  <li key={loan.id}>
                    <span>《{loan.book?.title ?? loan.book_id}》</span>
                    <em className={`kiosk-due is-${due.tone}`}>
                      {due.tone === "late" ? t("kiosk.home.due.late", { count: due.days }) : due.days === 0 ? t("kiosk.home.due.today") : t("kiosk.home.due.in", { count: due.days })}
                    </em>
                  </li>
                );
              })}
            </StaggerList>
          ) : <p className="kiosk-my-loans-empty">{t("kiosk.home.loans.empty")}</p>}
          {sorted.length > 5 ? <p className="kiosk-my-loans-more">{t("kiosk.home.loans.more", { count: sorted.length - 5 })}</p> : null}
        </aside>
      </div>
    </section>
  );
}

function CatalogSearch({ onSearch, onReserve }: { onSearch: (query: string) => Promise<Book[]>; onReserve: (book: Book) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle", query: "", results: [] });
  const latest = useRef(0);

  async function run(text: string) {
    const trimmed = text.trim();
    const id = ++latest.current;
    if (!trimmed) {
      setSearch({ status: "idle", query: "", results: [] });
      return;
    }
    setSearch((current) => ({ ...current, status: "loading", query: trimmed }));
    const results = await onSearch(trimmed).catch(() => [] as Book[]);
    // Ignore answers to queries the reader has already typed past.
    if (id === latest.current) setSearch({ status: "done", query: trimmed, results });
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void run(query), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void run(query);
  };

  return (
    <div className="kiosk-catalog-search">
      <form role="search" onSubmit={onSubmit}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" /><path d="M14 14l4 4" /></svg>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("kiosk.home.search.placeholder")}
          aria-label={t("kiosk.home.search.label")}
          autoComplete="off"
          spellCheck={false}
        />
        {query ? <button type="button" className="kiosk-catalog-clear" onClick={() => setQuery("")}>{t("kiosk.home.search.clear")}</button> : null}
      </form>
      {search.status !== "idle" ? (
        <div className="kiosk-catalog-results" role="region" aria-live="polite" aria-label={t("kiosk.home.search.results")}>
          {search.status === "loading" && !search.results.length ? <p className="kiosk-catalog-note">{t("kiosk.home.search.loading")}</p> : null}
          {search.status === "done" && !search.results.length ? <p className="kiosk-catalog-note">{t("kiosk.home.search.empty", { query: search.query })}</p> : null}
          {search.results.length ? (
            <StaggerList as="ul" replayKey={search.query} step={40}>
              {search.results.slice(0, 6).map((book) => {
                const onShelf = book.status === "on_shelf";
                return (
                  <li key={book.id}>
                    <i style={{ background: book.cover_color }} aria-hidden="true" />
                    <div>
                      <strong>《{book.title}》</strong>
                      <span>{book.author} · <span className="mono">{book.shelf_location}</span></span>
                    </div>
                    <em className={`kiosk-due ${onShelf ? "is-ok" : "is-soon"}`}>{t(onShelf ? "kiosk.home.search.onShelf" : "kiosk.home.search.onLoan")}</em>
                    {!onShelf && book.status === "borrowed" ? <button type="button" onClick={() => onReserve(book)}>{t("kiosk.home.search.reserve")}</button> : null}
                  </li>
                );
              })}
            </StaggerList>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
