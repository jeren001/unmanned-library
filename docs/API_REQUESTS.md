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

## 6. Device test command — open (mocked)

- **Endpoint:** `POST /api/devices/:id/test` (librarian/admin), body `{ "command": "ping" | "self_test" | "print_test" | "open_gate" | "snapshot" | "toggle" }`.
- **Reason:** the device drawer has a test console. Until the route exists, `testDevice` in `web/src/admin/adminApi.ts` answers with a mock based on the device status (online → OK with latency, offline → timeout, fault → error) and labels results "simulated".
- **Shape:** `{ "data": { "command": "ping", "ok": true, "latencyMs": 42, "output": "ping: OK", "at": "2026-10-09T10:00:00Z" } }`. Should go through the integration adapters and be audited.

## 7. Camera clip lookup — open (mocked)

- **Endpoint:** `GET /api/clips/:id` (librarian/admin) for `alerts.related_clip_id`.
- **Reason:** the alert drawer has a clip player. `camera_clips` exists in the schema but nothing serves it, and `file_path` is not a URL. Until then the player shows a clearly labelled simulated feed for the clip window (alert time −10 s … +20 s).
- **Shape:** `{ "data": { "id", "device_id", "branch_id", "start_ts", "end_ts", "url": "/api/clips/clip-1/video" } }` plus a streamable video at `url` (or `url: null` if the file is missing).

## 8. Alert acknowledgement time and resolve event — open

- **Endpoints:** `alerts` rows and the SSE stream.
- **Reason:** the alert timeline needs when an alert was acknowledged. Rows have `acked_by` but no time, so the UI uses `updated_at` and marks it "approximate". Also `POST /api/alerts/:id/resolve` publishes no event, so other open consoles only see resolutions on their next refresh.
- **Shape:** add `acked_at` to alerts (set in `ack`), and publish `alert.resolved` with the same `AlertEvent` payload.

## 9. Single device lookup — open

- **Endpoint:** `GET /api/devices/:id`.
- **Reason:** alerts and maintenance rows reference `device_id`; the frontend currently loads all devices (`limit=200`) to resolve names.

## 10. Bucketed telemetry series — open (mocked)

- **Endpoint:** `GET /api/telemetry/series?branchId=&metric=&from=&to=&bucket=<seconds>` (librarian/admin).
- **Reason:** the Telemetry page draws an average line with a min–max band per bucket. `GET /api/telemetry` returns at most 1000 raw rows **oldest first**, and the simulator writes a sample every 5 s, so one query over 24 h only covers its first ~80 minutes. Until this route exists, `fetchTelemetrySeries` in `web/src/admin/insightApi.ts` splits the range into 24–30 windows, queries them in parallel and buckets in the browser; windows that hit the cap are reported on the page as partial. `telemetry_hourly` already holds most of what is needed.
- **Shape:** buckets aggregate `quality = 'ok'` samples only; flagged samples are returned raw so the chart can draw them as hollow markers:

```json
{ "data": {
  "buckets": [{ "ts": "2026-10-09T00:00:00.000Z", "avg": 22.4, "min": 20.1, "max": 25.0, "count": 360 }],
  "flagged": [{ "id": "tel-…", "device_id": "device-east-5", "branch_id": "branch-east", "metric": "temperature", "value": 999999, "quality": "dirty", "ts": "2026-10-09T00:31:12Z" }],
  "samples": 17280
} }
```

## 11. Traceability chain — open (mocked)

- **Endpoint:** `GET /api/trace?bookId=…[&loanId=…]` (librarian/admin); `loanId` defaults to the book's latest loan. A `GET /api/loans/:id` would also help the search box resolve loan IDs.
- **Reason:** the Traceability page shows book → RFID tag → loan → device events → camera clip → alerts. Loans cannot be filtered by book or fetched by id, so the mock (`fetchTrace`) pages through all loans (≤ 25 × 200), then joins readers, devices, maintenance and alerts. Device events are only **derived** from loan timestamps; `gate_events` and the audit log are not served at all, and clips come only via `alerts.related_clip_id` (see #7).
- **Shape:**

```json
{ "data": {
  "book": { "id": "book-0010", "title": "…", "rfid_tag": "RFID-000010", "…": "…" },
  "loans": [{ "id": "loan-00009", "borrowed_at": "…", "status": "returned", "device_id": "device-east-1", "…": "…" }],
  "loan": { "id": "loan-00009", "…": "…" },
  "reader": { "id": "reader-010", "display_name": "…", "card_no": "…" },
  "device": { "id": "device-east-1", "name": "…", "kind": "kiosk", "…": "…" },
  "deviceEvents": [
    { "at": "…", "kind": "borrow", "deviceId": "device-east-1" },
    { "at": "…", "kind": "gate_exit", "deviceId": "device-east-3", "detail": "authorized" },
    { "at": "…", "kind": "return", "deviceId": "device-east-1" }
  ],
  "alerts": [{ "id": "alert-009", "related_loan_id": "loan-00009", "related_clip_id": "clip-009", "link": "loan", "…": "…" }]
} }
```

`deviceEvents[].kind` today: `borrow`, `renew`, `return`, `overdue`, `lost`, `maintenance`; please add gate reads (`gate_exit` / `gate_entry`, from `gate_events` whose `rfid_tags_json` contains the tag) and renew/return device ids from the audit log. `alerts[].link` is `loan` (via `related_loan_id`) or `device` (same device during the loan).

## 12. Export history (and optional server-side export) — open (mocked)

- **Endpoints:** `GET /api/exports?limit=50` and `POST /api/exports` (librarian/admin). Optional: `GET /api/exports/:dataset.xlsx?branchId=&from=&to=&metric=`.
- **Reason:** the Exports page builds the `.xlsx` in the browser from the list endpoints (≤ 10,000 rows, see `collectExport` in `web/src/admin/insightApi.ts` and `web/src/admin/xlsx.ts`). Its history is meant to be shared and audited, but without these routes it is kept in the browser's `localStorage` and labelled as such. Larger exports need the server-side export route.
- **Shape:** `POST` body and `GET` rows:

```json
{ "dataset": "loans", "branchId": "branch-east", "from": "2026-09-01", "to": "2026-09-30", "metric": null,
  "rows": 412, "filename": "ul_loans_EAST_2026-09-01_2026-09-30_20261010-0805.xlsx", "at": "2026-10-10T08:05:00Z", "by": "Admin" }
```

The server should fill `id`, `at` and `by` from the session and write an `audit_log` entry (`action: "export"`). `dataset` is one of `loans`, `books`, `readers`, `alerts`, `maintenance`, `devices`, `telemetry`.
