# API requests (frontend → backend)

The frontend appends requests here; the backend answers or implements them (see docs/WORKFLOW.md).

## 1. `call_number` on books — open

- **Endpoint:** `GET /api/books`, `GET /api/books/:id` (and the `book` embedded in loans, if any).
- **Reason:** the kiosk borrow flow and admin catalogue show a library call number (索书号, e.g. `TP311.5/S4`) in monospace on catalogue cards. The `books` table has no such column, so the kiosk currently shows the ISBN labelled "ISBN" instead.
- **Shape:** add a string field to each book:

```json
{ "id": "book-0001", "title": "软件体系结构", "isbn": "9787111…", "call_number": "TP311.5/S4", "category": "TP311", "shelf_location": "A-3-2" }
```

The frontend already reads `call_number` when present (`web/src/kiosk/kioskState.ts`, optional field), so no frontend change is needed once it ships.

## 2. Total count on list endpoints — open

- **Endpoints:** `GET /api/books`, `/api/readers`, `/api/loans`, `/api/alerts` (all take `limit`/`offset`).
- **Reason:** the admin tables paginate on the server but cannot show "page 3 of 12" or a result count. Today the frontend asks for `limit + 1` rows to know whether a next page exists (`web/src/admin/adminApi.ts`, `listPage`).
- **Shape:** add `total` next to `data` (same filters applied), e.g. `{ "data": [...], "total": 1240 }`. An `X-Total-Count` header would also work.

## 3. Book circulation history — open (mocked)

- **Endpoint:** `GET /api/books/:id/history` (librarian/admin), or `bookId` as a filter on `GET /api/loans`.
- **Reason:** the admin book drawer shows a history timeline. `GET /api/loans` only filters by `userId`, so the frontend mock (`fetchBookHistory` in `web/src/admin/adminApi.ts`) scans the latest 200 loans, which misses older history. The mock is used only while the route returns 404.
- **Shape:** newest first:

```json
{ "data": [
  { "at": "2026-10-12T09:30:00Z", "kind": "returned", "loanId": "loan-0042", "userId": "reader-001" },
  { "at": "2026-09-20T15:02:00Z", "kind": "borrowed", "loanId": "loan-0042", "userId": "reader-001" },
  { "at": "2025-03-01T00:00:00Z", "kind": "acquired" }
] }
```

`kind` is one of `acquired`, `borrowed`, `renewed`, `returned`, `overdue`, `lost`.

## 4. Book title and reader name on loans — open

- **Endpoint:** `GET /api/loans`.
- **Reason:** the circulation table shows the book title and reader name per row. Loans only carry ids, so the frontend resolves them with one cached `GET /api/books/:id` / `GET /api/readers/:id` per unique id.
- **Shape:** embed small summaries: `"book": { "id", "title", "shelf_location" }`, `"user": { "id", "display_name", "card_no" }`.

## 5. Readers list returns `password_hash` and staff accounts — open (security)

- **Endpoint:** `GET /api/readers`, `GET /api/readers/:id`.
- **Reason:** rows are raw `users` rows, so they include `password_hash` (and `qr_code`), and the list also returns librarian/admin accounts. The admin UI never displays them and filters to `role = "reader"`, but they should not leave the server.
- **Shape:** omit `password_hash`/`qr_code`, and filter the list to `role = 'reader'` on the server.
