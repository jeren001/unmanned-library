import { describe, expect, it } from "vitest";
import { ensureScreen, initialKioskState, KIOSK_SCREENS, kioskReducer, type KioskScreen } from "./kioskState";

const reader = { id: "reader-1", role: "reader" as const, name: "Reader", account: "CARD-1" };

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
    const signedIn = kioskReducer(initialKioskState, { type: "LOGIN", user: reader });
    const borrow = kioskReducer(signedIn, { type: "NAVIGATE", screen: "borrow" });
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

  it("never leaves a state without a screen", () => {
    const signedIn = kioskReducer(initialKioskState, { type: "LOGIN", user: reader });
    for (const screen of [...KIOSK_SCREENS, "bogus" as KioskScreen]) {
      for (const base of [initialKioskState, signedIn]) {
        const fixed = ensureScreen({ ...base, screen });
        expect(KIOSK_SCREENS).toContain(fixed.screen);
        if (["home", "borrow", "return", "renew", "reserve", "loans"].includes(fixed.screen)) expect(fixed.user).not.toBeNull();
        if (fixed.screen === "result") expect(fixed.result).not.toBeNull();
      }
    }
    expect(ensureScreen({ ...initialKioskState, screen: "bogus" as KioskScreen }).screen).toBe("idle");
    expect(ensureScreen({ ...signedIn, screen: "bogus" as KioskScreen }).screen).toBe("home");
    expect(kioskReducer(initialKioskState, { type: "NAVIGATE", screen: "home" }).screen).toBe("idle");
  });

  it("returns from help to the screen it was opened from without losing the flow", () => {
    const helpFromIdle = kioskReducer(initialKioskState, { type: "NAVIGATE", screen: "help" });
    expect(kioskReducer(helpFromIdle, { type: "BACK" }).screen).toBe("idle");

    const signedIn = kioskReducer(initialKioskState, { type: "LOGIN", user: reader });
    const book = { id: "b1", title: "Book", author: "A", isbn: "1", rfid_tag: "R1", branch_id: "branch-east", shelf_location: "A-1", cover_color: "#8E1B2E", status: "on_shelf" as const };
    const review = [
      { type: "NAVIGATE", screen: "borrow" },
      { type: "ADD_BOOK", book },
      { type: "SET_BORROW_STEP", step: "confirm" },
      { type: "NAVIGATE", screen: "help" },
      { type: "BACK" }
    ].reduce((state, action) => kioskReducer(state, action as Parameters<typeof kioskReducer>[1]), signedIn);
    expect(review.screen).toBe("borrow");
    expect(review.borrowStep).toBe("confirm");
    expect(review.scannedBookIds).toEqual(["b1"]);
  });

  it("steps back one screen at a time and keeps the reader signed in", () => {
    const identify = kioskReducer(initialKioskState, { type: "SHOW_IDENTIFY" });
    expect(kioskReducer(identify, { type: "BACK" }).screen).toBe("idle");

    const signedIn = kioskReducer(initialKioskState, { type: "LOGIN", user: reader });
    const confirm = kioskReducer(kioskReducer(signedIn, { type: "NAVIGATE", screen: "borrow" }), { type: "SET_BORROW_STEP", step: "confirm" });
    const scan = kioskReducer(confirm, { type: "BACK" });
    expect([scan.screen, scan.borrowStep]).toEqual(["borrow", "scan"]);
    const home = kioskReducer(scan, { type: "BACK" });
    expect(home.screen).toBe("home");
    expect(home.user).toEqual(reader);
    for (const screen of ["return", "renew", "reserve", "loans"] as const) {
      const back = kioskReducer(kioskReducer(signedIn, { type: "NAVIGATE", screen }), { type: "BACK" });
      expect([back.screen, back.user?.id]).toEqual(["home", reader.id]);
    }
    const result = kioskReducer(signedIn, { type: "RESULT", result: { kind: "success", title: "Done", detail: "" } });
    expect(kioskReducer(result, { type: "HOME" })).toMatchObject({ screen: "home", user: reader, result: null });
    expect(kioskReducer(signedIn, { type: "BACK" }).screen).toBe("home");
  });
});
