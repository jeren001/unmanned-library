# API

The server is layered as `API -> domain services -> repositories -> SQLite`. Route handlers validate input, call a service, and return JSON; SQL is kept in `server/src/persistence`.

Run the seeded API:

```bash
npm run seed
npm run dev -w server
```

Authentication uses an `httpOnly` `ul_session` cookie. Demo credentials:

- Reader: `R-2048` / `reader123`, card `20240001`
- Librarian: `librarian` / `librarian123`
- Admin: `admin` / `admin123`

## Response errors

Validation and domain failures use:

```json
{
  "code": "BOOK_UNAVAILABLE",
  "message": "Book is not available",
  "details": null
}
```

## Routes

All routes below require a session unless marked public. Reader sessions can use catalogue, circulation, and reservation endpoints. Librarian/admin sessions can manage readers, devices, alerts, telemetry, maintenance, rules, and overview statistics.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/public/stats` | Public login-page stats |
| `GET` | `/api/auth/me` | Current session |
| `POST` | `/api/auth/login` | Password login |
| `POST` | `/api/auth/card-login` | Reader card login |
| `POST` | `/api/auth/logout` | End session |
| `GET/POST` | `/api/books` | Catalogue list/create |
| `GET` | `/api/books/:id` | Catalogue detail |
| `GET/POST` | `/api/readers` | Reader list/create |
| `GET` | `/api/readers/:id` | Reader detail |
| `GET` | `/api/loans` | Loan history |
| `POST` | `/api/loans/borrow` | Borrow with idempotency key |
| `POST` | `/api/loans/:id/renew` | Renew active loan |
| `POST` | `/api/loans/:id/return` | Return loan |
| `GET/POST` | `/api/reservations` | Reservations |
| `GET/POST/PATCH` | `/api/devices` | Device management |
| `GET/POST` | `/api/alerts` | Alert list/create |
| `POST` | `/api/alerts/:id/ack` | Acknowledge alert |
| `POST` | `/api/alerts/:id/resolve` | Resolve alert |
| `GET/POST` | `/api/telemetry` | Query/ingest telemetry |
| `GET/POST` | `/api/maintenance` | Maintenance records |
| `GET/PUT` | `/api/rules` | Loan and threshold rules |
| `GET` | `/api/stats/overview` | Admin overview |
| `GET` | `/api/stream` | Authenticated SSE stream; optional `branchId`, `topics`, `Last-Event-ID` |
| `GET` | `/api/simulator/status` | Simulator status and queued telemetry |
| `POST` | `/api/simulator` | Enable or disable the simulator at runtime with `{"enabled":true}` |
| `POST` | `/api/simulator/scenario` | Inject `smoke_spike`, `device_offline`, `illegal_exit`, `sensor_glitch`, `network_outage`, `overload`, or `recover` |

The simulator runs inside the server when `SIMULATOR_ENABLED` is not `false`. Its interval and
deterministic seed are configurable with `SIMULATOR_INTERVAL_MS` and `SIMULATOR_SEED`.

SSE events use the event topic as the SSE event name and a monotonic sequence as `id`. A client
can reconnect with `Last-Event-ID`; the server replays events retained in the in-process buffer.

Scenario example:

```bash
curl -sS -b /tmp/library.cookies \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"overload","branchId":"branch-east"}' \
  http://localhost:3001/api/simulator/scenario
```

## Borrow, renew, return

Login and retain the cookie:

```bash
curl -i -c /tmp/library.cookies \
  -H 'Content-Type: application/json' \
  -d '{"role":"reader","account":"R-2048","password":"reader123"}' \
  http://localhost:3001/api/auth/login
```

Borrow an on-shelf book from the seeded data. Use `book-0001`, `reader-001`, `branch-east`, and a fresh idempotency key:

```bash
curl -sS -b /tmp/library.cookies \
  -H 'Content-Type: application/json' \
  -d '{"bookId":"book-0001","userId":"reader-001","branchId":"branch-east","deviceId":"device-east-1","idempotencyKey":"demo-borrow-0001"}' \
  http://localhost:3001/api/loans/borrow
```

Copy the returned `data.id`, then:

```bash
curl -sS -b /tmp/library.cookies -X POST \
  http://localhost:3001/api/loans/LOAN_ID/renew

curl -sS -b /tmp/library.cookies -X POST \
  http://localhost:3001/api/loans/LOAN_ID/return
```
