import { describe, expect, it } from "vitest";
import { initialKioskState, kioskReducer } from "./kioskState";

describe("kiosk workflow state machine", () => {
  it("moves from attract through identify and clears reader data on logout", () => {
    const identify = kioskReducer(initialKioskState, { type: "SHOW_IDENTIFY" });
    expect(identify.screen).toBe("identify");
    const home = kioskReducer(identify, { type: "LOGIN", user: { id: "reader-1", role: "reader", name: "Reader", account: "CARD-1" } });
    expect(home.screen).toBe("home");
    const populated = { ...home, loans: [{ id: "loan-1", book_id: "book-1", user_id: "reader-1", branch_id: "branch-east", borrowed_at: "", due_at: "", renew_count: 0, status: "active" as const }] };
    const loggedOut = kioskReducer(populated, { type: "LOGOUT" });
    expect(loggedOut.screen).toBe("idle");
    expect(loggedOut.user).toBeNull();
    expect(loggedOut.loans).toEqual([]);
  });

  it("supports a borrow scan, review, and completion transition", () => {
    const borrow = kioskReducer(initialKioskState, { type: "NAVIGATE", screen: "borrow" });
    const review = kioskReducer(borrow, { type: "SET_BORROW_STEP", step: "confirm" });
    const result = kioskReducer(review, { type: "RESULT", result: { kind: "success", title: "Borrowed", detail: "Done" } });
    expect(borrow.screen).toBe("borrow");
    expect(review.borrowStep).toBe("confirm");
    expect(result.screen).toBe("result");
  });

  it("keeps catalogue separate from books placed on the borrow tray", () => {
    const book = { id: "b1", title: "Book", author: "Author", isbn: "1", rfid_tag: "RFID-1", branch_id: "branch-east", shelf_location: "A-1", cover_color: "#1F4D3A", status: "on_shelf" as const };
    const withCatalog = kioskReducer(initialKioskState, { type: "SET_BOOKS", books: [book] });
    const withTag = kioskReducer(withCatalog, { type: "ADD_BOOK", book });
    expect(withTag.books).toHaveLength(1);
    expect(withTag.scannedBookIds).toEqual(["b1"]);
    const removed = kioskReducer(withTag, { type: "REMOVE_BOOK", bookId: "b1" });
    expect(removed.books).toHaveLength(1);
    expect(removed.scannedBookIds).toEqual([]);
  });
});
