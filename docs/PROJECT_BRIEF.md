# Unmanned Library (无人值守图书馆系统) — Project Brief

Course: Software Architecture (软件体系结构) lab. Graded on documents (requirements, architecture design, architecture review, reflection) plus a demo. The prototype must be polished AND show architecture decisions visibly.

## Product
Self-service library with no staff on site. Readers enter with a reader card/QR, borrow/return/renew/reserve books at a kiosk using RFID. Gate and sensors are monitored. Admins watch everything from a PC dashboard and a wallboard.

## Users and surfaces
- Reader: /kiosk (touch screen, bilingual, voice prompts)
- Librarian / Admin: /admin (management) and /admin/wallboard (big screen)
- Login page for all roles

## Functional requirements (priority)
1. Device sensing and status: kiosk, RFID gate, smart shelf, camera, temperature/humidity, light, smoke, PIR occupancy [P0 status, P1 environment curves]
2. Hardware compatibility via TCP/HTTP adapters (Adapter pattern) [P0]
3. Device management: register, bind to branch, online/offline, configure sampling interval and alarm thresholds, auto-register faults [P0]
4. Time-series processing: aggregate by branch+time, hourly/daily curves, flag dirty data [P1]
5. Book catalogue: ISBN, title, author, category, shelf location, edition, purchase date, RFID tag, status (on shelf / borrowed / lost / repair) [P0]
6. Reader records: registration, authentication (card / QR / ID), loan history, overdue records, deposit [P0]
7. Self-service: enter/exit, borrow, return, renew, reserve, anti-theft gate alarm, personal loans, overdue reminder [P0 borrow/return/renew, P1 reserve]
8. History storage and export: query by branch/time, Excel export, archive data older than 2 years [P0 export, P1 archive]
9. Admin wallboard: live environment, device overview, borrowing stats, headcount, alarm feed [P0]
10. Maintenance log: device repair, inventory, book mending, restocking [P1]
11. Data correlation: book <-> device <-> loan <-> camera clip (placeholder video OK) [P1]
P2 (placeholders only): mobile mini-program, AI book recommendation, smart lighting/AC linkage.

## Quality attributes (each needs a measurable scenario and an implemented tactic)
- Availability >= 99.5%; kiosk works offline with a local outbox and auto-sync; device faults never block borrow/return
- Security: hashed passwords, masked personal data, RBAC (reader/librarian/admin), gate alarms cannot be bypassed from UI, append-only audit log
- Performance: borrow/return <= 1 s, wallboard refresh <= 3 s, concurrent branches without message loss (batching + queue)
- Modifiability: new branch/sensor types via config + new adapter only; loan rules configurable without code changes (Strategy + rules table)
- Usability: kiosk usable in under 30 s, voice prompts, large targets
- Testability: simulated device data injection, scenario buttons, deterministic seed, no real hardware needed

## Constraints
Legacy hardware with limited interfaces; limited server resources; SQLite only; intermittent branch network; 6-week timeline, final submission by 20 October.

## Tech stack (fixed)
Node.js 20+, TypeScript, npm workspaces. /server: Express, better-sqlite3, zod, vitest, tsx. /web: Vite + React + TypeScript + Tailwind CSS, react-i18next, Apache ECharts. exceljs for Excel export. Server-Sent Events for realtime. No cloud services, no CDN: everything runs offline with `npm install && npm run dev`. Web on port 3000 (proxy /api to server on 3001).

## Architecture summary
Layered: Presentation -> API (REST + SSE) -> Domain services -> Integration (device adapters + simulator) -> Persistence (repositories over SQLite). In-process event bus (publish/subscribe) connects telemetry and circulation to alert rules, wallboard and audit log.
Patterns to use deliberately and name in code comments: Adapter, Factory, Strategy, Observer/Pub-Sub, Repository, State, Outbox + idempotency keys.
Folders: /server/src/{api,domain,integration,persistence,events,simulator}, /web/src/{kiosk,admin,shared}, /docs.

## Visual identity (details come later in docs/DESIGN_SYSTEM.md)
"Quiet Archive": warm paper, forest-ink, brass accent, serif display type, book-spine motif. No glassmorphism, no purple gradients, no stock hero photos.
