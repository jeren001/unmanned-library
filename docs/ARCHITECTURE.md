# Architecture

## Style

The system uses a layered architecture with an in-process event-driven spine.
REST handles commands and queries. An in-process publish/subscribe bus
(`server/src/events/bus.ts`) connects telemetry, circulation, gate events and
device status to the alert rules, the KPI feed and the SSE stream. Server-Sent
Events (`GET /api/stream`) push live state to the admin dashboard and wallboard.

Everything runs offline on one machine: one Node.js process, one SQLite file
(`server/data/library.sqlite`), and the Vite web app. There are no cloud
services. Real hardware is replaced by a deterministic simulator behind the same
adapter contract that real devices would use.

The diagrams below are drawn from the code on the `backend` branch (`/server`)
and the `frontend` branch (`/web`). Anything planned but not built is labelled
as such.

## 1. System Context

```mermaid
flowchart TB
  reader(["Reader<br/>card / QR / password"])
  staff(["Librarian / Admin"])
  wall(["Wallboard viewer<br/>big screen"])

  subgraph sys["Unmanned Library System"]
    ul["Web app + API server<br/>+ SQLite"]
  end

  devices["Branch devices<br/>kiosk, RFID reader, gate, smart shelf,<br/>camera, temp/humidity, light, smoke, PIR"]
  sim["Device simulator<br/>(stands in for hardware)"]
  excel[["Excel files<br/>(.xlsx download)"]]

  reader -- "borrow / return / renew / reserve<br/>at the kiosk" --> ul
  staff -- "manage catalogue, readers, devices,<br/>alerts, rules, exports" --> ul
  ul -- "live KPIs, alerts, device status (SSE)" --> wall
  devices -. "telemetry, gate passes, heartbeats<br/>(TCP / HTTP / legacy polling)" .-> ul
  sim -- "same events as devices,<br/>plus fault scenarios" --> ul
  ul -- "history export" --> excel
```

Branch networks are intermittent, so the kiosk keeps a local outbox and syncs
later (see sequence 5.2).

## 2. Containers

```mermaid
flowchart LR
  subgraph browser["Browser (Vite + React, port 3000)"]
    kiosk["/kiosk<br/>reader self-service"]
    admin["/admin<br/>management console"]
    wb["/admin/wallboard<br/>big screen"]
    idb[("IndexedDB<br/>kiosk outbox + cache<br/>(localStorage fallback)")]
    kiosk --- idb
  end

  subgraph node["Node.js process (Express, port 3001)"]
    api["REST API + SSE<br/>/api/*"]
    bus{{"In-process event bus"}}
    pipe["Telemetry pipeline<br/>500 ms batches"]
    simc["Simulator"]
    api --- bus
    pipe --> bus
    simc --> pipe
  end

  db[("SQLite<br/>server/data/library.sqlite<br/>WAL mode")]
  cli["CLI jobs<br/>npm run seed / archive / perf"]

  kiosk -- "HTTP JSON, cookie session" --> api
  admin -- "HTTP JSON" --> api
  admin -- "EventSource /api/stream" --> api
  wb -- "EventSource + 30 s polling fallback" --> api
  api --> db
  pipe --> db
  cli --> db
```

| Container | Technology | Responsibility | Code |
|---|---|---|---|
| Web app | Vite, React, TypeScript, react-i18next, ECharts | Kiosk, admin console, wallboard; dev server proxies `/api` to 3001 | `/web/src` (frontend branch) |
| Kiosk outbox | IndexedDB, falls back to localStorage | Holds borrow/return/renew/reserve actions made while offline | `/web/src/kiosk/kioskApi.ts` |
| API server | Express 5, zod, bcrypt | REST commands/queries, auth/RBAC, SSE, simulator control | `/server/src/api` |
| Event bus | In-process pub/sub with replay buffer (200 events) | Decouples producers from alert rules, KPIs and SSE | `/server/src/events/bus.ts` |
| Telemetry pipeline | In-memory queue, 500 ms flush, hourly rollup | Batches device samples, flags quality, persists, publishes | `/server/src/integration/telemetryPipeline.ts` |
| Simulator | Seeded PRNG, timers | Generates heartbeats, telemetry, gate passes, circulation; runs fault scenarios | `/server/src/simulator/index.ts` |
| Database | SQLite via better-sqlite3 (WAL, foreign keys on) | All persistent state, append-only audit log, telemetry archive | `/server/src/persistence/database.ts` |
| CLI jobs | tsx scripts | Seed demo data, archive old telemetry, measure performance | `/server/src/seed.ts`, `archive.ts`, `perf.ts` |

## 3. Components (API server)

```mermaid
flowchart TB
  subgraph API["api/"]
    server["server.ts<br/>composition root,<br/>simulator routes, error handler"]
    auth["auth.ts<br/>login, card-login, sessions,<br/>rate limit, requireAuth (RBAC)"]
    lib["library.ts<br/>REST routes + zod schemas"]
    stream["stream.ts<br/>SSE, topic/branch filter,<br/>Last-Event-ID replay"]
    pub["public.ts / health.ts"]
  end

  subgraph DOM["domain/"]
    circ["CirculationService<br/>borrow/return/renew/reserve"]
    policy["LoanPolicy<br/>(Strategy over rules table)"]
    state["bookState.ts<br/>(State: transition guard)"]
    svc["services.ts<br/>Catalog, Member, Device, Alert,<br/>Telemetry, Trace, Export,<br/>Maintenance, Rule"]
    rules["AlertRulesEngine<br/>(Observer)"]
    audit["AuditService"]
    privacy["privacy.ts<br/>masking"]
  end

  subgraph INT["integration/"]
    factory["DeviceAdapterFactory<br/>(Factory)"]
    adapters["adapters.ts<br/>TCP RFID, gate, HTTP sensor/camera,<br/>mock, legacy polling (Adapter)"]
    pipeline["TelemetryPipeline"]
  end

  sim["simulator/<br/>LibrarySimulator"]

  subgraph EV["events/"]
    bus["EventBus"]
    types["types.ts<br/>event contracts"]
    logger["logger.ts"]
  end

  subgraph PER["persistence/"]
    repo["LibraryRepository<br/>(Repository)"]
    dbm["database.ts<br/>schema, migrations,<br/>audit triggers"]
  end

  server --> auth & lib & stream & pub
  lib --> circ & svc & audit
  auth --> repo
  auth --> privacy
  circ --> policy & state & repo
  svc --> repo & factory & privacy
  factory --> adapters
  rules --> repo
  pipeline --> repo
  sim --> pipeline
  sim --> circ
  repo --> dbm

  circ -. "circulation.*" .-> bus
  svc -. "alert.*, device.status_changed" .-> bus
  pipeline -. "telemetry.received" .-> bus
  sim -. "gate.passed, device.status_changed,<br/>simulator.log" .-> bus
  rules -. "alert.raised" .-> bus
  bus -. "subscribe" .-> rules
  server -. "subscribes circulation/alert/device,<br/>publishes kpi.updated" .-> bus
  bus -. "subscribeAll" .-> stream
```

### Layers and allowed dependencies

| Layer | Responsibility | Calls (as built) |
|---|---|---|
| Presentation (`/web`) | Kiosk, admin, wallboard; REST + EventSource | API only |
| API (`/server/src/api`) | Routing, validation, auth/RBAC, SSE, error mapping | Domain; `server.ts` also wires persistence and the simulator as the composition root |
| Domain (`/server/src/domain`) | Business rules, state transitions, policies, alert rules, masking | Persistence (repositories); Integration (adapter factory) for device commands and health checks |
| Integration (`/server/src/integration`) | Device adapters, factory, telemetry pipeline | Persistence; publishes to the event bus |
| Simulator (`/server/src/simulator`) | Fake devices and scenarios | Integration (pipeline), Domain (`CirculationService` for simulated loans), Persistence |
| Persistence (`/server/src/persistence`) | SQL, schema, append-only audit log, archive | SQLite only |
| Events (`/server/src/events`) | Pub/sub, event contracts, logging | No business logic |

The original rule was strict layering (each layer calls only the one directly
below). In the code, the domain calls repositories directly and the simulator
calls a domain service. Both are deliberate shortcuts, recorded in
`docs/RISKS_AND_TRADEOFFS.md` (T1).

## 4. Data Model (main tables)

```mermaid
erDiagram
  branches ||--o{ books : holds
  branches ||--o{ devices : hosts
  users ||--o{ loans : borrows
  books ||--o{ loans : "lent in"
  devices ||--o{ loans : "kiosk used"
  users ||--o{ reservations : makes
  devices ||--o{ telemetry : emits
  devices ||--o{ gate_events : records
  devices ||--o{ camera_clips : records
  devices ||--o{ alerts : triggers
  alerts ||--o{ alert_notes : has
  alerts ||--o{ maintenance_records : "work order"
  telemetry }o--|| telemetry_hourly : "rolled up into"
  telemetry ||--o| telemetry_archive : "moved after 2 years"
  users ||--o{ audit_log : "acts (append-only)"
  rules {
    text key PK
    text value_json
  }
```

## 5. Sequences

### 5.1 Borrow at the kiosk (online)

```mermaid
sequenceDiagram
  autonumber
  actor R as Reader
  participant K as Kiosk (BorrowFlow.tsx / kioskApi.ts)
  participant A as API (auth.ts requireAuth + library.ts)
  participant C as CirculationService
  participant P as LoanPolicy (rules table)
  participant S as bookState.ts
  participant DB as LibraryRepository / SQLite
  participant B as EventBus
  participant W as SSE (stream.ts) → Wallboard

  R->>K: scan book (RFID)
  K->>A: POST /api/loans/borrow {bookId, userId, idempotencyKey}
  A->>A: session cookie → role check (operate)<br/>zod schema · reader may borrow only for self
  A->>C: borrow(input)
  C->>DB: findLoanByIdempotency(key)
  alt key already used (retry)
    DB-->>C: existing loan
    C-->>A: same loan (no second loan)
  else new request
    C->>DB: findBook, findUserById, count active loans
    C->>P: values() → maxLoans, loanDays
    C->>S: assertBookTransition(on_shelf → borrowed)
    C->>DB: UPDATE books status=borrowed
    C->>DB: INSERT loans (idempotency_key UNIQUE)
    C-)B: publishNoWait circulation.borrowed
    C-->>A: loan
  end
  A->>DB: audit_log INSERT (append-only)
  A-->>K: 201 {data: loan}
  K-->>R: "已借出 / Borrowed" + voice prompt
  B-)A: server.ts handler → kpi.updated
  B-)W: circulation.borrowed, kpi.updated (p95 ≈ 2 ms, docs/PERFORMANCE.md)
```

Device adapters are not on this path, so a faulty gate, shelf or sensor cannot
block a borrow. Errors map to `409 BOOK_UNAVAILABLE`, `409 MAX_LOANS_REACHED`,
`404 BOOK_NOT_FOUND` and `403 FORBIDDEN`.

### 5.2 Offline borrow and sync (kiosk outbox)

```mermaid
sequenceDiagram
  autonumber
  actor R as Reader
  participant K as Kiosk (kioskApi.ts)
  participant O as Outbox (IndexedDB, localStorage fallback)
  participant A as API
  participant C as CirculationService
  participant DB as SQLite

  R->>K: borrow while the branch network is down
  K->>A: POST /api/loans/borrow {.., idempotencyKey: kiosk-borrow-<uuid>}
  A--xK: network error (TypeError, no error code)
  K->>O: addOutbox({id = idempotencyKey, kind: borrow, payload, createdAt})
  K-->>R: provisional loan "offline-<key>", stamp "待同步 / Will sync"
  Note over K: due date uses cached loan_days rule

  Note over K,A: later: window "online" event
  K->>K: SET_NETWORK syncing
  K->>O: allOutbox() sorted by createdAt
  loop each queued action, oldest first
    K->>A: replay the request with the same idempotencyKey
    A->>C: borrow(input)
    C->>DB: findLoanByIdempotency(key)
    alt first delivery
      C->>DB: create loan, publish circulation.borrowed
    else already delivered before the response was lost
      DB-->>C: existing loan (no duplicate)
    end
    alt 2xx
      A-->>K: loan
      K->>O: removeOutbox(id)
    else domain error (e.g. 409 BOOK_UNAVAILABLE, 401 session expired)
      A-->>K: error
      K-->>R: "同步冲突 / Reconciliation: …" and stop the loop
    end
  end
  K->>K: refresh outbox count, SET_NETWORK online
```

There is no server-side outbox table or sync endpoint. The server's part is
the idempotency key on borrow (`loans.idempotency_key UNIQUE`). Return and
renew have no idempotency key: a repeated return is harmless (the loan is
already returned), but a repeated renew is not. These gaps are risks R2 and
R3 in `docs/RISKS_AND_TRADEOFFS.md`.

### 5.3 Alert pipeline (sensor threshold and gate theft)

```mermaid
sequenceDiagram
  autonumber
  participant D as Device adapter / Simulator
  participant Q as TelemetryPipeline
  participant DB as Repository / SQLite
  participant B as EventBus
  participant AR as AlertRulesEngine
  participant SV as server.ts KPI handler
  participant SSE as stream.ts
  participant AS as AlertService (via library.ts)
  actor L as Librarian (AlertsPage / Wallboard)

  D->>Q: enqueue(sample) e.g. smoke_ppm = 20
  Note over Q: timer flush every 500 ms (one batch at a time)
  Q->>Q: quality = ok / suspect / dirty<br/>(range, jump, stale, 999999 garbage)
  Q->>DB: INSERT telemetry + upsert telemetry_hourly
  Q->>B: publish telemetry.received
  B->>AR: telemetry(event)
  AR->>DB: getRules() → alert_thresholds
  alt dirty sample
    AR-->>AR: ignore (data is kept but raises no alert)
  else threshold exceeded
    AR->>AR: de-duplicate: in-memory key branch:device:type<br/>within alert_dedup_seconds (default 60 s)
    AR->>DB: findRecentOpenAlert(...)
    AR->>DB: INSERT alerts (smoke → critical, other → warning)
    AR-)B: publish alert.raised
  end
  B-)SV: alert.raised → kpi.updated (openAlerts)
  B-)SSE: telemetry.received, alert.raised, kpi.updated
  SSE-->>L: event stream (id = seq, replay on reconnect)

  Note over D,AR: gate path
  D->>B: publish gate.passed {authorized: false, rfidTags}
  B->>AR: gate(event)
  AR->>DB: findNearestClip(branch, ts)
  AR->>DB: INSERT alerts type=theft, critical, related_clip_id
  AR-)B: alert.raised

  L->>AS: POST /api/alerts/:id/ack {note?} (librarian/admin only)
  AS->>DB: UPDATE alerts status=acked, INSERT alert_notes
  AS-)B: alert.acked → SSE
  L->>AS: POST /api/alerts/:id/resolve
  AS->>DB: UPDATE alerts status=resolved, resolved_at
  AS-)B: alert.resolved → SSE
```

A device that misses 3 heartbeats becomes `offline` in the simulator tick and
publishes `device.status_changed`; the same engine raises a `device_offline`
alert. `POST /api/devices/:id/health-check` creates a `device_fault` alert and a
draft maintenance record directly in `DeviceService`.

## 6. Folder Layout

| Path | Layer |
|---|---|
| `/web/src/kiosk` | Presentation: reader kiosk, state reducer, outbox client |
| `/web/src/admin` | Presentation: admin console and `/admin/wallboard` |
| `/web/src/shared` | Presentation: shared UI, i18n, icons |
| `/server/src/api` | API: REST, SSE, auth, validation |
| `/server/src/domain` | Domain services, policies, state transitions, alert rules, masking |
| `/server/src/integration` | Device adapters, adapter factory, telemetry pipeline |
| `/server/src/simulator` | Deterministic device simulator and scenario injection |
| `/server/src/persistence` | SQLite schema, migrations, repositories, export and archive queries |
| `/server/src/events` | In-process event bus, event contracts, logger |
| `/docs` | Requirements, architecture, API contract, quality, risks |

## 7. Patterns

| Pattern | Where used | Problem solved | Quality attribute |
|---|---|---|---|
| Adapter | `server/src/integration/adapters.ts` (`TcpRfidAdapter`, `GateControllerAdapter`, `HttpSensorAdapter`, `HttpCameraAdapter`, `MockAdapter`, `LegacyPollingAdapter`) | One `DeviceAdapter` contract over different vendors and protocols | Modifiability, availability |
| Factory | `server/src/integration/factory.ts` | Picks the adapter from `devices.protocol` and `kind` | Modifiability, testability |
| Strategy | `server/src/domain/loanPolicy.ts` + `rules` table; thresholds in `alertRules.ts` | Loan days, limits, renewals and thresholds change through `PUT /api/rules/:key` without code changes | Modifiability |
| Observer / Pub-Sub | `server/src/events/bus.ts`, subscribers in `alertRules.ts`, `server.ts`, `stream.ts` | Producers do not know about alert rules, KPIs or the wallboard; failing handlers are isolated | Performance, availability, testability |
| Repository | `server/src/persistence/repositories.ts` | SQL lives in one place; tests use `:memory:` databases | Testability, modifiability |
| State | `server/src/domain/bookState.ts`; `web/src/kiosk/kioskState.ts` | Only legal book transitions (for example on_shelf → borrowed); named kiosk workflow actions | Security, usability |
| Outbox + idempotency key | `web/src/kiosk/kioskApi.ts` (outbox); `CirculationService.borrow` + `loans.idempotency_key` (dedupe) | Kiosk keeps working offline and retries safely | Availability |
| Batching queue | `server/src/integration/telemetryPipeline.ts` | Bursts of samples are written in batches without loss | Performance |

## 8. Priority Split

| Priority | Components | State |
|---|---|---|
| P0 | Login/auth/RBAC, kiosk borrow/return/renew, catalogue, reader records, device registration/status/faults, adapters, gate alarms, history query/export, wallboard, repositories, event bus, audit log, outbox/idempotency | Built; QR-only login and a server-side sync API are missing |
| P1 | Environment curves, dirty data flags, reservations, archive job, maintenance log, data correlation (trace + placeholder clips), simulator scenarios | Built |
| P2 | Mobile mini-program, AI recommendations, smart lighting/AC linkage | Placeholders only (`docs/API.md`, Missing Endpoints) |
