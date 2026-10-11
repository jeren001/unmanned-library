# Risks and Trade-offs

This file records the main architecture trade-offs and the open risks in the
current code (`backend` branch for `/server`, `frontend` branch for `/web`). It
is input for the architecture review. Scenario IDs (AV-1, SE-3, …) refer to
`docs/QUALITY_TRACEABILITY.md`.

## Trade-offs

### T1 Relaxed layering instead of strict layers

| | |
|---|---|
| Decision | Domain services call repositories directly. The simulator calls `CirculationService` for simulated loans. `api/server.ts` is the composition root and wires persistence, bus and simulator. |
| Alternative | Strict layering (API → Domain → Integration → Persistence only), with the simulator talking to the API like a real device. |
| Gain | Fewer pass-through classes, short call paths (borrow p95 23 ms), code a two-person team can read in a six-week course. |
| Cost | Domain logic depends on the concrete `LibraryRepository`, and the simulator is coupled to the domain. Replacing SQLite or moving the simulator to its own process would touch more files. |
| Affects | Modifiability (−), performance (+), testability (neutral: `:memory:` SQLite keeps tests fast) |

### T2 In-process event bus instead of a message broker

| | |
|---|---|
| Decision | `EventBus` is an in-memory publish/subscribe with handler isolation and a 200-event replay buffer (`server/src/events/bus.ts`). |
| Alternative | A broker such as MQTT, Redis Streams or RabbitMQ, or a durable event table in SQLite. |
| Gain | No extra process, no network hop, runs offline with `npm run dev` (a project constraint). Delivery is sub-millisecond and handlers are easy to test. |
| Cost | Events exist only in memory: a crash loses undelivered events, and SSE replay covers only the last 200. Everything is tied to one Node process, with no horizontal scaling and no branch-local servers. |
| Affects | Performance (+), testability (+), availability (−), scalability (−) |

### T3 SQLite with a synchronous driver

| | |
|---|---|
| Decision | One SQLite file in WAL mode accessed through `better-sqlite3` (synchronous calls). |
| Alternative | PostgreSQL or another client-server database, or an asynchronous driver. |
| Gain | Required by the brief (SQLite only, limited server resources). Zero setup and a single file to back up. Synchronous calls make each request handler effectively atomic within one process, so two borrows of the same book cannot interleave. |
| Cost | One writer at a time. Long queries (large exports, archive) block the event loop and delay every other request and SSE push. No network access for branch-local servers. |
| Affects | Performance (+ at this scale, − for heavy jobs), availability (−: single point of failure) |

### T4 Server-Sent Events plus polling instead of WebSockets

| | |
|---|---|
| Decision | Live updates go one way over `GET /api/stream` (SSE). The wallboard also polls every 30 s. |
| Alternative | WebSockets, or polling only. |
| Gain | Plain HTTP that works through the Vite proxy, reuses cookie auth, and reconnects in the browser with `Last-Event-ID`. Measured event-to-SSE p95 is 2–470 ms, far under 3 s. |
| Cost | Server → client only, so commands still use REST. The replay window is bounded (200 events), and the polling fallback adds load. |
| Affects | Performance (+), availability (+), modifiability (+) |

### T5 Client-side outbox instead of a server sync protocol

| | |
|---|---|
| Decision | The kiosk stores offline actions in IndexedDB and replays them against the normal REST endpoints; the server's part is the borrow idempotency key. |
| Alternative | A dedicated `POST /api/kiosk/sync` endpoint that authenticates the kiosk as a device and processes a batch with per-item results. |
| Gain | No new server API; the same validation and RBAC apply to replayed actions; the kiosk keeps working through outages. |
| Cost | Replays run under whatever session the kiosk holds at sync time; return/renew are not idempotent; conflicts stop the whole queue (see R2, R3). |
| Affects | Availability (+), security (neutral), correctness under partitions (−) |

### T6 Batching telemetry every 500 ms

| | |
|---|---|
| Decision | Samples are queued and flushed in batches every 500 ms (`TelemetryPipeline`). |
| Alternative | Write and publish each sample on arrival. |
| Gain | Bursts of 500 samples per branch are absorbed without loss (11,000/11,000 in the perf run), and the alert rules see a steady stream. |
| Cost | Up to 500 ms extra latency per sample (probe p95 470 ms). The queue is in memory, so samples waiting for a flush are lost on a crash. |
| Affects | Performance: throughput (+), latency (−); availability (−) |

### T7 Mask personal data for every role

| | |
|---|---|
| Decision | Email, card number, student number and QR code are masked in every response and export, including for admins (`server/src/domain/privacy.ts`). |
| Alternative | Role-based unmasking, or a "reveal" action that writes an audit entry. |
| Gain | One simple rule that is easy to test (security test checks 0 leaks); exports cannot leak contact data. |
| Cost | Staff cannot read a reader's full email or card number in the UI to contact them or check a card; search still works server-side on the raw values. |
| Affects | Security (+), usability for staff (−) |

### T8 Sessions, rate limits and alert de-duplication held in memory

| | |
|---|---|
| Decision | Sessions, login rate-limit buckets, failed-attempt counters and the alert de-dup map are in process memory. |
| Alternative | Store them in SQLite tables. |
| Gain | No extra writes on every request; simple code. |
| Cost | A restart logs out every kiosk and admin and resets rate limits. Alert de-dup falls back to a database lookup (`findRecentOpenAlert`), so it survives restarts. |
| Affects | Performance (+), availability (−), security (− slightly: limits reset on restart) |

## Risks

Likelihood and impact are rated High / Medium / Low.

| ID | Risk | Likelihood | Impact | Evidence | Mitigation |
|---|---|---|---|---|---|
| R1 | **Borrow is not atomic.** `CirculationService.borrow` marks the book `borrowed` and then inserts the loan as two separate statements. If the insert fails, the book stays `borrowed` with no loan. This was reproduced: a borrow with an unknown `deviceId` fails with `FOREIGN KEY constraint failed` (HTTP 500) and leaves the book stuck. `returnLoan` has the same two-step shape. | Medium | High (book unusable until fixed by hand; P0 flow) | `server/src/domain/circulationService.ts` (`borrow`, `returnLoan`) | Wrap each command in `db.transaction(...)` in the repository. Validate `deviceId`/`branchId` exist before writing. Add a test that a failed insert leaves the book `on_shelf`. |
| R2 | **Offline sync can fail or stall.** Actions replay under the session present at sync time: if a different reader (or nobody) is logged in, borrows return `403`/`401`. Returning a book that was borrowed offline queues `loanId=offline-…`, which the server rejects with `404`. `syncOutbox` stops at the first error, so one bad item blocks every later item. | High during outages | High (availability scenario AV-2; lost or blocked loans) | `web/src/kiosk/kioskApi.ts` (`syncOutbox`, `returnBook`); `server/src/api/library.ts` (reader self-check) | Authenticate the kiosk as a device for sync (a kiosk role or device token) and add `POST /api/kiosk/sync` with per-item results. Map `offline-<key>` loans to the borrow idempotency key on the server. Skip and flag conflicting items instead of stopping the loop. |
| R3 | **Renew and return are not idempotent.** A retried renew (lost response, outbox replay) extends the loan twice and uses up an extra renewal. | Medium | Medium (wrong due dates, reader complaints) | `server/src/domain/circulationService.ts` (`renew`); `web/src/kiosk/kioskApi.ts` (`renewLoan`) | Accept an `idempotencyKey` on renew/return and store it (for example a `loan_events` table with a unique key). Return the stored result on replay. |
| R4 | **Single process with volatile state.** A crash or restart loses sessions (every kiosk logged out), queued telemetry, the SSE replay buffer and rate-limit counters. There is no supervisor, and the 99.5 % availability target is not measured. | Medium | High (AV-3 not demonstrable; kiosks need re-login) | `server/src/api/auth.ts` (`sessions` map); `server/src/integration/telemetryPipeline.ts`; `server/src/events/bus.ts` | Persist sessions in SQLite. Flush the pipeline on `SIGTERM`. Run under a supervisor (systemd/pm2) with restart-on-failure. Log `/api/health` probes to measure uptime for the report. |
| R5 | **Gate authorization trusts the device.** The theft rule fires only when the gate reports `authorized=false` or an `RFID-UNKNOWN` tag. The server does not check tags against active loans, so a misconfigured or legacy gate that always reports `authorized=true` lets books leave without an alarm. | Low (simulated) / Medium (real gates) | High (security requirement "gate alarms cannot be bypassed") | `server/src/domain/alertRules.ts` (`gate`) | On `gate.passed` with `direction=out`, look up each `rfidTag` in `books` and raise `theft` if the book is not `borrowed`. Treat the device flag as one input, not the decision. |
| R6 | **Telemetry growth slows queries.** At the default 5 s simulator interval, 3 branches emit about 36 samples per tick, roughly 600,000 rows per day. `GET /api/telemetry` aggregates from raw rows, and the archive job only moves rows older than 2 years. A long-running demo machine will slow down and the SQLite file will grow. | High (if left running) | Medium (slower dashboard, possible PE-2 miss) | `server/src/simulator/index.ts` (`tick`); `server/src/persistence/repositories.ts` (`telemetryAggregate`) | Raise `SIMULATOR_INTERVAL_MS` for long demos. Serve hourly/daily curves from `telemetry_hourly`. Schedule `npm run archive`, and add a shorter retention for simulator-only metrics. Re-run `npm run perf` after a day of data. |
| R7 | **Alert handling is not in the audit log.** Ack, resolve and alert notes are stored in `alerts` and `alert_notes` (with `acked_by`), but not in the append-only `audit_log`. Device config changes, reader status changes and book edits are also not audited. | High | Medium (weaker accountability for the security story) | `server/src/api/library.ts` (alert, device, reader and book routes have no `services.audit.log`) | Add `audit.log` calls for ack/resolve/notes, device config, reader status and book updates, and add the check to `security.test.ts`. |
| R8 | **Two-branch integration drift.** `/server` and `/web` are developed on separate branches by separate agents, and the frontend branch has not been merged with the latest backend changes (masked fields, 403 instead of 409 for `FORBIDDEN`, stricter validation, `RULE_NOT_FOUND`). | Medium | High before the 20 October demo | `docs/WORKFLOW.md`; `docs/API.md` | Merge both branches into `master` well before the deadline. Run the full flow (kiosk borrow → wallboard) on the merged build. Treat `docs/API.md` as the contract and check the frontend against it. |
| R9 | **Heavy jobs block the event loop.** Excel export of large datasets, the archive job, and `rollupTelemetry` run synchronously in the server process (`better-sqlite3`), so borrow requests and SSE pushes wait while they run. | Medium | Medium (PE-1/PE-2 spikes during exports) | `server/src/domain/services.ts` (`ExportService`); `server/src/persistence/repositories.ts` (`archiveTelemetryBefore`, `rollupTelemetry`) | Cap export size or stream in pages. Run archive from the CLI (`npm run archive`) outside opening hours. Measure with `npm run perf` while an export runs. |

## Review notes

- R1 and R2 are the highest priority: both hit P0 borrow/return and the
  availability story, and both have small, local fixes.
- The trade-offs T2, T3 and T8 are acceptable for the course constraints
  (offline, SQLite only, one machine). Their costs are what R4 and R9 describe.
- The architecture review should check that every "partial" row in
  `docs/QUALITY_TRACEABILITY.md` maps to a risk here: AV-2 → R2/R3,
  AV-3 → R4, SE-4 → `POST /api/readers` accepts a pre-hashed password
  (documented in `docs/API.md`), MO-3 → no branch API, US-1 → not yet measured.
