import { DomainError, type BookStatus } from "./types.js";

const transitions: Record<BookStatus, BookStatus[]> = {
  on_shelf: ["borrowed", "repair", "lost"],
  borrowed: ["on_shelf", "lost"],
  lost: ["on_shelf", "repair"],
  repair: ["on_shelf", "lost"]
};

// State pattern: all book status changes pass through this transition guard.
export function assertBookTransition(from: BookStatus, to: BookStatus) {
  if (!transitions[from]?.includes(to)) {
    throw new DomainError("ILLEGAL_BOOK_STATE", `Cannot move book from ${from} to ${to}`);
  }
}
