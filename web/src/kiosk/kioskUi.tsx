import { useTranslation } from "react-i18next";
import type { BookStatus } from "../shared/components";
import { formatDate as formatLocalDate, formatNumber } from "../shared/i18n";
import { AlertIcon } from "../shared/icons";
import type { Book, Loan } from "./kioskState";
import "./kiosk-ui.css";

/* Small helpers shared by the restyled kiosk flows. Text comes from the locale files, one language at a time. */

const DAY_MS = 86400000;

/** Month and day in the selected UI language ("11月13日" / "Nov 13"). */
export function formatDate(value: string | Date) {
  return formatLocalDate(value);
}

export function callNumberOf(book: Book) {
  // Without an explicit label the catalogue card shows its translated "call no." label.
  return book.call_number ? { value: book.call_number, label: undefined } : { value: book.isbn, label: "ISBN" };
}

export function bookStatusOf(book: Book): BookStatus {
  return book.status === "on_shelf" ? "in" : book.status === "borrowed" ? "borrowed" : "repair";
}

/** Whole days until the due date (negative when overdue). */
export function daysLeft(loan: Loan, now = Date.now()) {
  return Math.ceil((new Date(loan.due_at).getTime() - now) / DAY_MS);
}

export function overdueDays(loan: Loan, now = Date.now()) {
  return Math.max(0, Math.ceil((now - new Date(loan.due_at).getTime()) / DAY_MS));
}

export function formatFine(cents: number) {
  return formatNumber(cents / 100, { style: "currency", currency: "CNY" });
}

/**
 * Kiosk messages (errors, result titles) are kept as i18n keys in state and translated on render,
 * so they follow a later language switch. Anything else (e.g. dev-drawer text) is shown as is.
 */
export function useKioskText() {
  const { t } = useTranslation();
  return (text: string, values?: Record<string, string | number>) => (text.startsWith("kiosk.") ? t(text, values) : text);
}

/** Error slip in the catalogue-card language: rose spine, serif heading, message. */
export function ErrorCard({ title, message }: { title: string; message: string }) {
  return (
    <div className="kiosk-error-card" role="alert">
      <span className="kiosk-error-card-spine" aria-hidden="true" />
      <AlertIcon />
      <div>
        <strong>{title}</strong>
        <p className="kiosk-error">{message}</p>
      </div>
    </div>
  );
}
