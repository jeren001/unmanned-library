import type { BookStatus } from "../shared/components";
import { AlertIcon } from "../shared/icons";
import type { Book, Loan } from "./kioskState";
import "./kiosk-ui.css";

/* Small helpers shared by the restyled kiosk flows. Strings stay bilingual like the rest of the kiosk. */

const DAY_MS = 86400000;

export function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

export function callNumberOf(book: Book) {
  return book.call_number ? { value: book.call_number, label: "索书号 / Call no." } : { value: book.isbn, label: "ISBN" };
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
  return `¥${(cents / 100).toFixed(2)}`;
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
