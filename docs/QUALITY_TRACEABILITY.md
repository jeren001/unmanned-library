# Quality Traceability

Each quality attribute from `docs/PROJECT_BRIEF.md` is traced here:
quality attribute → scenario (source, stimulus, environment, artifact,
response, measure) → tactic → code paths → demo step → status.

- `/server/...` paths are on the `backend` branch. `/web/...` paths are on the
  `frontend` branch (worktree `unmanned-library-frontend`).
- Status values: **implemented** means built and demonstrable; **partial** means
  built with a known gap, which is named in the row; **planned** means not built.
- Measured numbers come from `npm test -w server` (301 tests) and
  `docs/PERFORMANCE.md` (`npm run perf -w server`).

## Summary

| ID | Quality attribute | Scenario | Main tactic | Status |
|---|---|---|---|---|
| AV-1 | Availability | A device fails during opening hours | Fault isolation: circulation path never calls devices | implemented |
| AV-2 | Availability | Branch network drops during a borrow | Kiosk outbox + idempotency key | partial |
| AV-3 | Availability | Server process crashes or restarts (≥ 99.5 % target) | Durable SQLite state, health endpoint, SSE reconnect + polling | partial |
| AV-4 | Availability | Database write fails in the middle of a telemetry batch | Re-queue the unprocessed tail, no replay of committed rows | implemented |
| SE-1 | Security | Wrong role calls a protected route | Authenticate + authorize (RBAC), reader self-scoping | implemented |
| SE-2 | Security | Password or card-number brute force | Lockout + per-account and per-IP rate limits | implemented |
| SE-3 | Security | Staff or log readers see reader records | Mask personal data in responses, exports, audit, logs | implemented |
| SE-4 | Security | Database file is copied | bcrypt password hashes | partial |
| SE-5 | Security | Someone tries to edit or delete the audit log | Append-only audit log (no route, repository guard, SQLite triggers) | implemented |
| SE-6 | Security | Unauthorized exit, then attempt to hide the alarm from the UI | Server-side gate rule; UI can only ack/resolve with a manage role | implemented |
| PE-1 | Performance | Borrow/return during an overload burst | Short synchronous transaction path, async events | implemented |
| PE-2 | Performance | Event must reach the wallboard within 3 s | Pub-sub + SSE push, 500 ms batching | implemented |
| PE-3 | Performance | Concurrent bursts from several branches | Queue + batch flush, no drop | implemented |
| MO-1 | Modifiability | New device vendor / protocol | Adapter + Factory | implemented |
| MO-2 | Modifiability | Change loan rules at runtime | Strategy over the `rules` table | implemented |
| MO-3 | Modifiability | Add a branch or a new sensor type | Data-driven branches, devices and thresholds | partial |
| US-1 | Usability | First-time reader borrows a book in < 30 s | Task-focused kiosk flow, State reducer, bilingual UI | partial |
| US-2 | Usability | Reader needs guidance or walks away | Voice prompts, inactivity logout | implemented |
| TE-1 | Testability | Demo a fault without hardware | Simulator + scenario injection | implemented |
| TE-2 | Testability | Same demo data on every machine | Deterministic seed and simulator PRNG | implemented |
| TE-3 | Testability | Regression check after a change | Repository boundary, `:memory:` SQLite, mock adapters, Vitest | implemented |

## Availability

### AV-1 Device faults never block borrow/return

| Field | Value |
|---|---|
| Source | A branch device (gate, smart shelf, sensor, camera) |
| Stimulus | It stops sending heartbeats or fails a health check |
| Environment | Normal operation, branch open |
| Artifact | `CirculationService`, `DeviceService`, `EventBus` |
| Response | Borrow/return keep working. The device is marked `offline`/`fault`, a `device_offline`/`device_fault` alert is raised, and a draft maintenance record is created for failed health checks. |
| Measure | Borrow still returns `201` while the device is offline; 0 borrow failures caused by device state; a failing event subscriber does not fail the publisher |
| Tactic | Fault isolation: the borrow/return path has no dependency on adapters. Handler isolation in the bus. Heartbeat monitoring (3 missed intervals). Automatic fault registration. |
| Code | `/server/src/domain/circulationService.ts`; `/server/src/domain/services.ts` (`DeviceService.healthCheck`); `/server/src/events/bus.ts`; `/server/src/simulator/index.ts` (`tick`, `device_offline`, `network_outage`, `recover`); `/server/src/domain/alertRules.ts` |
| Demo | Admin → Simulator: run `device_offline` (or `POST /api/simulator/scenario {"scenario":"device_offline"}`). Borrow a book at `/kiosk` (success). Show the new alert in `/admin` alerts. Run `recover`. Tests: `services.test.ts` "auto-registers a fault alert and draft maintenance record after failed health check"; `bus.test.ts` "isolates failing handlers". |
| Status | implemented |

### AV-2 Kiosk works offline with a local outbox and auto-sync

| Field | Value |
|---|---|
| Source | Branch network |
| Stimulus | The connection drops while a reader borrows, returns, renews or reserves |
| Environment | Degraded: kiosk cut off from the server, server running |
| Artifact | Kiosk client (`kioskApi.ts`), `POST /api/loans/borrow` |
| Response | The action is stored in the local outbox and the reader gets a provisional "待同步 / Will sync" receipt. On the browser `online` event, queued actions are replayed oldest first. A replayed borrow with an idempotency key the server has already seen returns the existing loan. |
| Measure | 100 % of queued borrows replayed after reconnect; 0 duplicate loans for a repeated idempotency key |
| Tactic | Local outbox (IndexedDB, localStorage fallback); idempotency key (`loans.idempotency_key UNIQUE`); retry on reconnect; cached rules and catalogue for offline use |
| Code | `/web/src/kiosk/kioskApi.ts` (`addOutbox`, `syncOutbox`, `borrowBook`); `/web/src/kiosk/KioskPage.tsx` (online/offline listeners); `/web/src/kiosk/kioskState.ts` (`network`, `outboxCount`); `/server/src/domain/circulationService.ts` (`findLoanByIdempotency`); `/server/src/persistence/database.ts` (`loans`) |
| Demo | In `/kiosk`, open DevTools → Network → Offline. Borrow a book and see the "待同步" stamp and the outbox count. Switch back to Online and see "已同步 1 笔操作". Show one loan in `/admin` circulation. Test: `services.test.ts` "borrows idempotently and transitions the book". |
| Status | partial. Gaps: return and renew carry no idempotency key (a replayed renew renews twice). Actions queued under one reader's session fail with `401`/`403` if another reader or no one is logged in at sync time. Returning a book borrowed offline queues `loanId=offline-…`, which the server rejects with `404`. Sync stops at the first error, so one bad item blocks the queue. There is no server-side sync endpoint. |

### AV-3 Availability ≥ 99.5 % across restarts

| Field | Value |
|---|---|
| Source | Server host / Node.js process |
| Stimulus | The process crashes or is restarted |
| Environment | Single machine, SQLite file on local disk |
| Artifact | API server, SQLite database, SSE clients |
| Response | All business state survives in SQLite. Clients reconnect on their own: EventSource retries and replays with `Last-Event-ID`, and the wallboard polls every 30 s as a fallback. |
| Measure | ≥ 99.5 % monthly availability (≤ 3.6 h downtime/month); the wallboard shows "reconnecting" and then recovers without a reload |
| Tactic | Durable state (SQLite WAL); health check (`GET /api/health`); client reconnect + polling fallback; SSE replay buffer (200 events) |
| Code | `/server/src/persistence/database.ts` (`journal_mode = WAL`); `/server/src/api/health.ts`; `/server/src/api/stream.ts`; `/server/src/events/bus.ts` (`replaySince`); `/web/src/admin/wallboard/WallboardPage.tsx` (`POLL_MS`, `onerror`) |
| Demo | Open `/admin/wallboard`, stop the server (Ctrl+C), and the status chip shows reconnecting/offline. Restart with `npm run dev -w server`; the wallboard recovers and the data is unchanged. |
| Status | partial. Gaps: there is no process supervisor or uptime monitoring, so the 99.5 % figure is not measured. Sessions live in memory, so a restart logs everyone out. The telemetry queue and the bus replay buffer are in memory and lost on a crash. |

### AV-4 Telemetry batch survives a write failure

| Field | Value |
|---|---|
| Source | SQLite (disk full, lock timeout) |
| Stimulus | A write fails partway through a telemetry flush |
| Environment | Under load |
| Artifact | `TelemetryPipeline.flush` |
| Response | Samples already committed are not written again. The unprocessed tail goes back to the front of the queue for the next flush. |
| Measure | 0 lost and 0 duplicated samples after the failure clears |
| Tactic | Retry with a re-queued tail; single in-flight batch (`processing` guard) |
| Code | `/server/src/integration/telemetryPipeline.ts` (`flush` catch block) |
| Demo | Code walk-through of `flush()`. Related test: `telemetryPipeline.test.ts` "keeps samples enqueued during an overload flush for the next batch" (concurrent enqueue; the failure path itself has no automated test). |
| Status | implemented (failure path not covered by a test) |

## Security

### SE-1 RBAC on every route

| Field | Value |
|---|---|
| Source | Anonymous visitor, or a reader at the kiosk |
| Stimulus | Calls a librarian/admin route (for example `/api/stream`, `/api/devices`, `/api/simulator/*`) or another reader's records |
| Environment | Normal operation |
| Artifact | API layer |
| Response | `401 UNAUTHENTICATED` or `403 FORBIDDEN`, with no data and no side effect. Reader requests for loans and reservations are scoped to the session user. |
| Measure | All 60 routes × 4 roles (240 checks) return the status in the matrix; the test fails if a new route is not in the matrix |
| Tactic | Authenticate (random 256-bit session id in an `HttpOnly`, `SameSite=Lax` cookie); authorize (`requireAuth(...roles)`); reader self-scoping in route handlers |
| Code | `/server/src/api/auth.ts` (`requireAuth`); `/server/src/api/library.ts`; `/server/src/api/server.ts`; `/server/src/api/security.test.ts` ("RBAC matrix") |
| Demo | `npm test -w server -- security`. Manual: log in as reader `R-2048`, open `http://localhost:3001/api/stream` and get `403`; log in as `librarian` and the stream opens. |
| Status | implemented |

### SE-2 Brute-force protection on login and card login

| Field | Value |
|---|---|
| Source | Attacker at a kiosk or on the network |
| Stimulus | Repeated passwords for one account, or many different card numbers |
| Environment | Normal operation |
| Artifact | `POST /api/auth/login`, `POST /api/auth/card-login` |
| Response | After 5 wrong passwords the account is locked for 10 minutes (`423`). More than 12 attempts per minute for one account, or 30 per minute from one IP, return `429`. Each attempt is audited. |
| Measure | 13th attempt on one account → `429`; 31st rotated card number from one IP → `429` |
| Tactic | Limit access (lockout, sliding-window rate limits); audit of failures |
| Code | `/server/src/api/auth.ts` (`createRateLimiter`, `LOCK_MS`, `failedAttempts`); `/server/src/api/security.test.ts` ("login rate limiting") |
| Demo | `npm test -w server -- security`, or send 13 wrong logins with curl and show the `429` |
| Status | implemented (limits are per process and in memory) |

### SE-3 Personal data is masked

| Field | Value |
|---|---|
| Source | Librarian, admin, or anyone reading exports or logs |
| Stimulus | Lists readers, opens a reader, exports readers, reads `audit_log` or console output |
| Environment | Normal operation |
| Artifact | `MemberService`, `ExportService`, auth audit, logger |
| Response | `password_hash` is never returned. Email shows as `r***@domain`; card number, student number and QR code keep only the last 4 characters; ID numbers are stored already masked. Failed card logins and email-shaped accounts are masked in the audit log. Event logs carry no payloads. |
| Measure | 0 raw emails, card numbers or QR codes in API responses, Excel exports, `audit_log` and console output during the security test |
| Tactic | Data minimization and masking at the domain boundary |
| Code | `/server/src/domain/privacy.ts`; `/server/src/domain/services.ts` (`MemberService`, `ExportService.exportRows`); `/server/src/api/auth.ts` (`audit`); `/server/src/events/logger.ts`; `/server/src/api/security.test.ts` ("personal data masking") |
| Demo | `/admin` → Readers shows `****0001` and `r***@library.local`. Export readers to Excel and open the file. |
| Status | implemented |

### SE-4 Passwords are stored hashed

| Field | Value |
|---|---|
| Source | Someone who copies `server/data/library.sqlite` |
| Stimulus | Reads the `users` table |
| Environment | Offline attack on the file |
| Artifact | `users.password_hash` |
| Response | Only bcrypt hashes (cost 10) are stored; login compares with `bcrypt.compare` |
| Measure | 0 plaintext passwords in the database |
| Tactic | One-way salted hashing |
| Code | `/server/src/seed.ts` (`bcrypt.hashSync`); `/server/src/api/auth.ts` (`safePasswordCompare`) |
| Demo | `sqlite3 server/data/library.sqlite "select username, password_hash from users limit 3"` shows `$2b$10$…` |
| Status | partial. `POST /api/readers` accepts a pre-hashed `password_hash` instead of hashing a password (documented in `docs/API.md`). |

### SE-5 Append-only audit log

| Field | Value |
|---|---|
| Source | An admin, or a bug in the server |
| Stimulus | Tries to change or delete audit entries |
| Environment | Normal operation |
| Artifact | `audit_log` table |
| Response | No HTTP route touches it; `LibraryRepository.update/delete` throw for `audit_log`; SQLite triggers abort any `UPDATE`/`DELETE`. Logins, card logins, logouts, borrow/return/renew, reminders, maintenance, rule changes, exports and archive runs are appended. |
| Measure | `UPDATE`/`DELETE` on `audit_log` fail with "append-only"; 0 routes match `audit` or `DELETE` |
| Tactic | Append-only store enforced at two levels (application and database) |
| Code | `/server/src/persistence/database.ts` (`ensureAuditLogImmutable`); `/server/src/persistence/repositories.ts` (`assertMutable`, `recordAudit`); `/server/src/domain/auditService.ts`; `/server/src/api/security.test.ts` ("audit log") |
| Demo | `sqlite3 server/data/library.sqlite "delete from audit_log"` → `Error: audit_log is append-only`. |
| Status | implemented (`npm run seed` drops and re-creates the triggers to reset demo data; alert ack/resolve is recorded in `alerts`/`alert_notes`, not in `audit_log`) |

### SE-6 Gate alarms cannot be bypassed from the UI

| Field | Value |
|---|---|
| Source | Reader leaving with an unborrowed book, or a user trying to silence the alarm |
| Stimulus | An unauthorized gate pass (`authorized=false` or unknown RFID tag), then UI actions on the alert |
| Environment | Normal operation, branch unattended |
| Artifact | `AlertRulesEngine.gate`, `gate_events`, `alerts` |
| Response | The server raises a critical `theft` alert linked to the nearest camera clip, whatever any UI does. No route disables the gate rule. Readers cannot read, ack or resolve alerts (`403`); staff can ack/resolve, but the alert row and its note timeline remain. |
| Measure | `theft` alert within 3 s of the gate event; reader `POST /api/alerts/:id/ack` → `403` |
| Tactic | Server-side enforcement; Observer on `gate.passed`; RBAC on alert commands |
| Code | `/server/src/domain/alertRules.ts` (`gate`); `/server/src/simulator/index.ts` (`illegal_exit`); `/server/src/api/library.ts` (alert routes, `manage`); `/server/src/persistence/repositories.ts` (`findNearestClip`) |
| Demo | Run the `illegal_exit` scenario; the theft alert with its camera clip appears on the wallboard and in `/admin` alerts; open Trace for the alert. |
| Status | implemented (the "authorized" decision is taken by the gate device; the server does not yet cross-check RFID tags against active loans) |

## Performance

### PE-1 Borrow/return ≤ 1 s

| Field | Value |
|---|---|
| Source | Readers at kiosks in several branches |
| Stimulus | Concurrent borrow and return requests |
| Environment | Overload: a 500-sample `overload` scenario every second, simulator running |
| Artifact | `POST /api/loans/borrow`, `POST /api/loans/:id/return` |
| Response | Each request completes and events are published asynchronously |
| Measure | p95 ≤ 1 s. Measured: borrow p95 23.1 ms, return p95 22.7 ms (6,387 cycles, 8 clients) |
| Tactic | Short synchronous path with indexed lookups; fire-and-forget events (`publishNoWait`); SQLite WAL |
| Code | `/server/src/domain/circulationService.ts`; `/server/src/events/bus.ts`; `/server/src/perf.ts` |
| Demo | `npm run perf -w server` and open `docs/PERFORMANCE.md` |
| Status | implemented |

### PE-2 Wallboard refresh ≤ 3 s

| Field | Value |
|---|---|
| Source | Sensor, gate or circulation event |
| Stimulus | The event happens |
| Environment | Overload, as in PE-1 |
| Artifact | Event bus → `GET /api/stream` → wallboard |
| Response | The event and the updated KPIs are pushed to every SSE client |
| Measure | Event-to-SSE p95 ≤ 3 s. Measured p95: circulation 2 ms, overload telemetry 101 ms, API probe including 500 ms batching 470 ms (browser render time not included) |
| Tactic | Pub-sub; server push (SSE) instead of polling; KPI recomputation on each relevant event; 500 ms batching |
| Code | `/server/src/api/stream.ts`; `/server/src/api/server.ts` (`publishKpi`); `/server/src/integration/telemetryPipeline.ts`; `/web/src/admin/wallboard/WallboardPage.tsx`; `/server/src/domain/alertRules.test.ts` ("turns a simulator scenario into an alert within 3 seconds") |
| Demo | Open `/admin/wallboard` next to `/kiosk`; borrow a book and watch the KPI change; run `smoke_spike` and watch the alert feed |
| Status | implemented |

### PE-3 Concurrent branches without message loss

| Field | Value |
|---|---|
| Source | Devices in all branches |
| Stimulus | Bursts of 500 samples per branch, repeated |
| Environment | Overload |
| Artifact | `TelemetryPipeline`, `EventBus`, SQLite |
| Response | Every sample is persisted and published once; dirty samples are kept and flagged |
| Measure | 500/500 persisted per burst (test); 11,000/11,000 overload samples delivered over SSE in the perf run |
| Tactic | Queue + batch flush (500 ms); single in-flight batch; hourly rollup table |
| Code | `/server/src/integration/telemetryPipeline.ts`; `/server/src/simulator/index.ts` (`overload`); `/server/src/integration/telemetryPipeline.test.ts` ("does not lose an overload batch and preserves dirty samples") |
| Demo | Run `overload` from Admin → Simulator; check `GET /api/telemetry?branchId=…&metric=overload_7`; run `npm run perf -w server` |
| Status | implemented (an SSE client that reconnects mid-burst gets at most the last 200 events; the wallboard's 30 s poll fills the gap) |

## Modifiability

### MO-1 New device vendor or protocol

| Field | Value |
|---|---|
| Source | Developer |
| Stimulus | A branch installs a new sensor vendor with its own protocol |
| Environment | Design time |
| Artifact | Integration layer |
| Response | Add one adapter class that implements `DeviceAdapter` and one factory branch; register the device with `POST /api/devices` |
| Measure | Changes confined to `adapters.ts` and `factory.ts`; 0 changes in domain, API or persistence |
| Tactic | Adapter + Factory; normalized telemetry and gate payloads; capability limits (legacy adapter is polling-only) |
| Code | `/server/src/integration/types.ts`; `/server/src/integration/adapters.ts`; `/server/src/integration/factory.ts`; `/server/src/integration/adapters.test.ts` ("creates adapters with the common contract") |
| Demo | Show `LegacyPollingAdapter` (added without domain changes); register a `legacy` device in Admin → Devices and run test-command → `LEGACY_POLLING_ONLY` |
| Status | implemented |

### MO-2 Loan rules change without code

| Field | Value |
|---|---|
| Source | Librarian |
| Stimulus | Change the loan period from 30 to 45 days (or max loans, renewals, fines, thresholds) |
| Environment | Runtime, server running |
| Artifact | `rules` table, `LoanPolicy` |
| Response | The next borrow uses the new value; the change is validated and audited (`update_rule`) |
| Measure | 0 code changes, 0 restarts; takes effect on the next request |
| Tactic | Strategy over a rules table; per-key validation |
| Code | `/server/src/domain/loanPolicy.ts`; `/server/src/api/library.ts` (`PUT /api/rules/:key`, `ruleValueSchemas`); `/server/src/persistence/repositories.ts` (`upsertRule`); `/web/src/admin/OverviewRules.tsx` |
| Demo | Admin → Rules: set `loan_days` to 45, borrow at the kiosk, and the due date is 45 days out |
| Status | implemented (a new kind of rule still needs code, because keys are validated against a fixed list) |

### MO-3 New branch or sensor type through configuration

| Field | Value |
|---|---|
| Source | Library operator |
| Stimulus | Open a new branch, or add a new sensor metric |
| Environment | Runtime |
| Artifact | `branches`, `devices`, `rules.alert_thresholds` |
| Response | Simulator, wallboard, exports and stats iterate over branches from the database; a new metric gets thresholds through `alert_thresholds` |
| Measure | No code change for a new branch or a new threshold |
| Tactic | Data-driven configuration |
| Code | `/server/src/simulator/index.ts` (`tick` iterates branches); `/server/src/domain/alertRules.ts`; `/server/src/api/library.ts` (`POST /api/devices`) |
| Demo | `PUT /api/rules/alert_thresholds` with a new metric; register a device in Admin → Devices |
| Status | partial. There is no `POST /api/branches` (a branch needs a seed or database edit), and the pipeline's quality ranges for known metrics are hard-coded in `telemetryPipeline.ts`. |

## Usability

### US-1 Kiosk borrow in under 30 s

| Field | Value |
|---|---|
| Source | First-time reader |
| Stimulus | Wants to borrow one book |
| Environment | Kiosk touch screen, normal operation |
| Artifact | `/kiosk` |
| Response | Identify (card/QR) → Borrow → scan → result, with large targets and Chinese/English text |
| Measure | Task completed in < 30 s by a first-time user |
| Tactic | Task-focused flow; explicit State reducer; bilingual UI; large touch targets |
| Code | `/web/src/kiosk/BorrowFlow.tsx`; `/web/src/kiosk/kioskState.ts`; `/web/src/kiosk/KioskPage.tsx`; `/web/src/shared/i18n.ts`; `docs/KIOSK_STATE_MACHINE.md` |
| Demo | Time a classmate borrowing one book at `/kiosk` with card `20240001` |
| Status | partial (built; the 30 s target has not been measured with users) |

### US-2 Voice guidance and inactivity logout

| Field | Value |
|---|---|
| Source | Reader |
| Stimulus | Completes a step, or walks away mid-session |
| Environment | Kiosk |
| Artifact | `KioskPage.tsx` |
| Response | Spoken bilingual prompt (Web Speech API, can be switched off); after inactivity a countdown warning, then logout that clears reader state |
| Measure | Prompt on each result; session cleared after the timeout |
| Tactic | Multimodal feedback; automatic session timeout |
| Code | `/web/src/kiosk/KioskPage.tsx` (`speak`, inactivity guard); `/web/src/kiosk/kioskState.ts` (`LOGOUT`) |
| Demo | Borrow with voice on; leave the kiosk idle and watch the countdown and logout |
| Status | implemented |

## Testability

### TE-1 Inject device data and faults without hardware

| Field | Value |
|---|---|
| Source | Developer or examiner |
| Stimulus | Needs smoke, offline, theft, glitch, outage, overload or recovery |
| Environment | Demo or development, no hardware |
| Artifact | Simulator, scenario API, admin Simulator page |
| Response | The scenario runs through the same pipeline, bus and rules as real devices |
| Measure | 7/7 scenarios runnable from the UI or API; scenario → alert within 3 s (test) |
| Tactic | Simulator behind the device contract; controllable inputs (start/stop/speed/scenario) |
| Code | `/server/src/simulator/index.ts`; `/server/src/api/server.ts` (`/api/simulator/*`); `/web/src/admin/SimulatorPage.tsx`; `/server/src/simulator/index.test.ts` |
| Demo | Admin → Simulator: click each scenario and watch the live event log on the page (alerts, status changes from `/api/stream`) |
| Status | implemented |

### TE-2 Deterministic demo data

| Field | Value |
|---|---|
| Source | Developer |
| Stimulus | Re-creates demo data on another machine |
| Environment | Fresh checkout |
| Artifact | Seed script, simulator |
| Response | Same branches, books, readers, loans, telemetry, alerts and clips every time (fixed clock 2026-10-07, seeded PRNG); simulator sequence fixed by `SIMULATOR_SEED` |
| Measure | Seed prints identical counts (`branches=3 books=300 readers=60 … telemetry=10812`); identical IDs |
| Tactic | Fixed seed and clock; reset before insert |
| Code | `/server/src/seed.ts`; `/server/src/simulator/index.ts` (`random`); `docs/DEMO_ACCOUNTS.md` |
| Demo | `npm run seed` twice and compare the output |
| Status | implemented (bcrypt salts differ between runs) |

### TE-3 Automated regression tests without hardware

| Field | Value |
|---|---|
| Source | Developer |
| Stimulus | Changes server code |
| Environment | Development / CI |
| Artifact | Vitest suite |
| Response | Domain, pipeline, bus, adapters, simulator, HTTP security and archive are checked against in-memory SQLite and mock adapters |
| Measure | `npm test -w server`: 8 files, 301 tests pass in ≈ 3 s |
| Tactic | Repository boundary; dependency injection (`createServer(":memory:")`, injected bus/factory); mock adapters |
| Code | `/server/src/**/*.test.ts`; `/server/src/persistence/repositories.ts`; `/server/src/integration/factory.ts` |
| Demo | `npm test -w server` |
| Status | implemented |
