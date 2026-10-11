import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, fetchBookHistory, listPage, loanEvents, withMock, type BookRow, type LoanRow } from "./adminApi";

function respond(...bodies: Array<[number, unknown]>) {
  const fetchMock = vi.fn();
  for (const [status, body] of bodies) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

const loan = (patch: Partial<LoanRow>): LoanRow => ({
  id: "loan-1", book_id: "book-1", user_id: "reader-001", branch_id: "branch-east",
  borrowed_at: "2026-09-01T10:00:00Z", due_at: "2026-10-01T10:00:00Z", returned_at: null, renew_count: 0, status: "active", ...patch
});

describe("listPage", () => {
  it("asks for one extra row and reports a next page", async () => {
    const fetchMock = respond([200, { data: [1, 2, 3] }]);
    await expect(listPage<number>("/api/books", { page: 2, pageSize: 2, status: "all", q: "三体" })).resolves.toEqual({ rows: [1, 2], hasNext: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/books?limit=3&offset=2&q=%E4%B8%89%E4%BD%93");
  });
});

describe("withMock", () => {
  it("uses the mock only when the route is missing", async () => {
    respond([404, {}]);
    await expect(withMock(() => api("/api/x"), async () => "mocked")).resolves.toBe("mocked");
    respond([404, { code: "BOOK_NOT_FOUND" }]);
    await expect(withMock(() => api("/api/x"), async () => "mocked")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("history", () => {
  it("derives borrow, renew and overdue events from a loan", () => {
    const kinds = loanEvents(loan({ renew_count: 1 }), Date.parse("2026-10-05T00:00:00Z")).map((event) => event.kind);
    expect(kinds).toEqual(["borrowed", "renewed", "overdue"]);
  });

  it("falls back to the loans list when the history route is missing", async () => {
    respond([404, {}], [200, { data: [loan({ status: "returned", returned_at: "2026-09-20T10:00:00Z" }), loan({ id: "other", book_id: "book-2" })] }]);
    const book = { id: "book-1", purchased_at: "2025-01-01T00:00:00Z" } as BookRow;
    const events = await fetchBookHistory(book);
    expect(events.map((event) => event.kind)).toEqual(["returned", "borrowed", "acquired"]);
  });
});
