# Motion spec

Source of truth: `docs/reference/library-ux-motion.html` (interactive concept) and `docs/reference/concept-full.png` (static capture).
Compared against the app in `web/src` as of commit `6607450`. No app code was changed to produce this document.

Timings below are from the concept's CSS and JS. "t" is the moment of the triggering click.
"RM" means `prefers-reduced-motion: reduce`. In the concept, RM sets `animation: none` and `transition: none` on every element, applies three overrides (receipt open, ribbon full length, book cover hidden), and shortens its JS timers to 10 ms.

## 1. Animation inventory (concept)

### 1.1 Login: reader card and opening book

| # | Name | Where | Trigger | Duration | Easing | Technique | RM fallback |
|---|------|-------|---------|----------|--------|-----------|-------------|
| L1 | Spine rise | Shelf band under the top bar (`.band i`, 44 spines) | Page load | 700 ms each, staggered 30 ms (~2 s in total) | `cubic-bezier(.2,.9,.3,1.2)` (slight overshoot) | CSS keyframes `rise`: `scaleY(0→1)`, `transform-origin: bottom`, `animation-delay` per spine | Spines are drawn at full height |
| L2 | Spine lift | Same spines | Hover | 200 ms | `ease` | CSS transition on `translate: 0 -7px` | Spine moves at once, with no transition |
| L3 | Button press | All `.btn` | `:active` / hover | 150 ms (transform), 200 ms (background) | `ease` | CSS transition `scale(.97)` and a darker background | Changes at once |
| L4 | Card insert | Reader card (`.rc`) slides into the slot | Click «模拟刷卡» | 1000 ms | `cubic-bezier(.6,.05,.2,1)` (heavy) | CSS transition `translateY(118px)`, masked by `.cover` under the slot | Card jumps into place |
| L5 | Slot LED | `.led` on the slot | t + 900 ms | 300 ms | `ease` | CSS transition from grey to green | Turns green at once |
| L6 | RFID waves | 3 arcs above the slot (`.wv`) | t + 900 ms | 1100 ms × 2 iterations; delays 0, 200, 400 ms | `ease-out` | Keyframes `wv`: `scale(.4→1.9)`, `translateY(-8px)`, opacity .9→0 | Not shown |
| L7 | Welcome line | «✓ 欢迎，读者» (`.ok-b`) | t + 900 ms | 500 ms | `ease` | CSS transition: opacity 0→1, `translateY(8px→0)` | Appears at once |
| L8 | Cover fade-in | Full-panel overlay, burgundy cover (`.cv`) | t + 2500 ms | 400 ms | `ease-out` | Keyframes `cin`: opacity 0→1 | Cover hidden (`opacity:0`) |
| L9 | Book opens | Cover swings open around its left edge | t + 3300 ms | 1300 ms | `cubic-bezier(.6,.05,.2,1)` | Keyframes `cop`: `rotateY(0→-118deg)`, `perspective:1500px`, `backface-visibility:hidden` | Cover hidden; destination page shown |
| L10 | Tile pop | 3 service tiles on the revealed page (`.tl div`) | t + 3300 ms (with L9) | 600 ms; delays 0, 120, 240 ms | `cubic-bezier(.2,1.3,.4,1)` (springy) | Keyframes `pop`: `scale(.4) rotate(-8deg)` → none, plus a fade-in | ⚠ Concept bug: the tiles keep `opacity:0`, so they never appear |
| — | Role tabs | Reader / Librarian / Admin | Click | — | — | Panels swap instantly (no animation) | — |

### 1.2 Kiosk: page turns, catalog drawer, bookmark, shelf map

| # | Name | Where | Trigger | Duration | Easing | Technique | RM fallback |
|---|------|-------|---------|----------|--------|-----------|-------------|
| K1 | Page turn | Whole kiosk body, every screen change (home → step 1 → 2 → 3 → home, home → return) | Any navigation except the first render | 550 ms | `cubic-bezier(.2,.8,.2,1)` | Keyframes `turn`: `perspective(900px) rotateY(-14deg) translateX(18px)` + fade → none, origin left | Content swaps at once |
| K2 | New-books ticker | Strip under the search bar (`.tk`) | Always (home) | 30 s loop | `linear` | Keyframes `mq`: `translateX(-50%)` over duplicated content; edges faded with a `mask-image` gradient | Static strip, clipped |
| K3 | Service tile rise | Borrow / Return / Renew / Reserve tiles | Home render | 550 ms; delays 50, 120, 190, 260 ms | `cubic-bezier(.2,.9,.3,1)` | Keyframes `up`: `translateY(18px)` + fade | Tiles shown at once |
| K4 | Tile hover lift | Same tiles | Hover | 180 ms | `ease` | CSS transition `translateY(-3px)` | Moves at once |
| K5 | Loan row rise | «我的借阅» rows (`.ln2`) | Home render | 500 ms; delays 350 ms + 100 ms × i | `ease` | Keyframes `up` | Rows shown at once |
| K6 | Loan count-up | «我的借阅 · N» | Home render | 700 ms | linear | `requestAnimationFrame` counter from 0 to N | Final value shown |
| K7 | Overdue pulse | «已逾期» badge (`.late`) | Always while visible | 1800 ms loop | `ease-in-out` | Keyframes `pl`: `box-shadow` ring 0 → 5 px → 0 | Static badge |
| K8 | Stepper state | «① 放书 ② 确认 ③ 取小票» pills | Step change | 300 ms | `ease` | CSS transition on background and color (current step burgundy, done steps green) | Changes at once |
| K9 | Book bob | Book on the tray (`.tray .bk`) | Click «模拟放入图书» | 600 ms (bob); 400 ms opacity .35→1 | `ease-in-out` | Keyframes `bob`: `translateY(-8px)` at 40%, plus an opacity transition | Book at full opacity, no movement |
| K10 | Scan line | Rose line sweeping the tray (`.sl`) | Same | 800 ms, once | `ease-in-out` | Keyframes `sl`: `top 4%→94%` | Not shown |
| K11 | Tray rings | 3 RFID rings (`.rg`) | Same | 1100 ms; delays 0, 200, 400 ms | `ease-out` | Keyframes `rg`: `scale(.5→3.2)`, opacity .8→0 | Not shown. Auto-advance to step 2 after 10 ms instead of 1100 ms |
| K12 | Catalog drawer | Catalog card rising out of the wooden drawer (`.dw .cat`), step 2 | Step 2 render | 900 ms | `cubic-bezier(.2,1.15,.4,1)` (overshoot) | Keyframes `dr`: `translateY(300px)` → none; the drawer front sits above it on `z-index` | Card shown in place |
| K13 | Receipt print | Receipt slip (`.slip`), step 3 | Step 3 render + 60 ms | 1600 ms | `steps(14)` (printer tick) | CSS transition on `max-height: 0→340px` | Slip shown fully open |
| K14 | Stamp | «已借出» stamp on the slip (`.stp`) | Step 3 + 1.5 s | 400 ms | `cubic-bezier(.2,.9,.3,1.3)` | Keyframes `st`: `rotate(-14deg) scale(2.2→1)`, opacity →.9 | ⚠ Concept bug: the stamp stays at `opacity:0` and never appears |
| K15 | Bookmark ribbon | Rose ribbon dropping from the top edge (`.rib`), step 3 | Step 3 + 1.2 s | 900 ms | `cubic-bezier(.3,1.5,.5,1)` (bounce) | Keyframes `rb`: `height 0→110px`, `clip-path` swallowtail | Full 110 px ribbon |
| K16 | Route march | Dashed route on the shelf map (Return screen) | Always | 1 s loop | linear | SVG SMIL `<animate stroke-dashoffset 28→0>` | ⚠ Not covered: CSS cannot stop SMIL |
| K17 | Walker dot | Rose dot moving along the route | Always | 3 s loop | paced (SMIL default) | SVG SMIL `<animateMotion>` + `<mpath>` | ⚠ Not covered (SMIL) |
| K18 | Target shelf pulse | A-3-2 shelf rectangle (`.shl`) | Always | 1400 ms loop | `ease-in-out` | Reuses `pl` (`box-shadow`) | ⚠ Has no visible effect: `box-shadow` does not render on SVG `<rect>` |

### 1.3 Admin: count-up, row wave, card drawer, alarm

| # | Name | Where | Trigger | Duration | Easing | Technique | RM fallback |
|---|------|-------|---------|----------|--------|-----------|-------------|
| A1 | KPI count-up | 4 KPI cards: 在馆 / 今日借出 / 逾期 / 设备在线% | Admin panel scrolls into view (IntersectionObserver, threshold .3, once) | 1200 ms | ease-out cubic (`1-(1-t)^3`) | `requestAnimationFrame` counter, optional suffix | Final value shown |
| A2 | Row wave | Books table rows (`tr.rw`) | Initial render and each filter change | 450 ms; stagger 60 ms | `ease` | Keyframes `up`: `translateY(18px)` + fade | Rows shown at once |
| A3 | Row hover | Table rows | Hover | instant | — | Blush row tint, no transition | — |
| A4 | Sidebar hover | Sidebar links (`.sb a`) | Hover | 200 ms | `ease` | CSS transition: background tint + `padding-left 10→14px` (link slides right). Active link: blush background, wood left border | Changes at once |
| A5 | Filter chip | 全部 / 在架 / 借出 / 逾期 / 维修 | Click | 200 ms | `ease` | CSS transition on background, color and border. Also closes the drawer and replays A2 | Changes at once |
| A6 | Book card drawer | Right-side panel with details and history timeline (`.dr`) | Row click (open); × or filter change (close) | 450 ms | `cubic-bezier(.2,.9,.3,1)` | CSS transition `translateX(105%)` → none | Panel appears at once |
| A7 | Bell ring | Bell icon in the header | Click «模拟告警» (badge count +1) | 800 ms | `ease-in-out` | Keyframes `ring`: rotate 18° / −16° / 10° / −6°, origin `50% 10%`; restarted with a reflow | Badge updates, no swing |
| A8 | Alert toast | «东馆 · 烟雾告警» toast, top right | Same; hides after 3.6 s | 450 ms in and out | `cubic-bezier(.2,1.2,.4,1)` | CSS transition `translateY(-90px)` + opacity | Appears and disappears at once |
| A9 | Overdue pulse | «逾期» badge in the table | Always | 1800 ms loop | `ease-in-out` | Same `pl` keyframes as K7 | Static |

Shared easing vocabulary in the concept: **out** `(.2,.9,.3,1)`, **spring** `(.2,1.15,.4,1)`, **rise** `(.2,.9,.3,1.2)`, **page** `(.2,.8,.2,1)`, **heavy** `(.6,.05,.2,1)`. The app has the same five values in `web/src/shared/motion.tsx` (`easing`).

## 2. Concept vs. current app

Legend: ✅ implemented · 🟡 partial or different · ❌ missing · ➕ app only (not in the concept)

### 2.1 Login (`login/LoginPage.tsx`, `login/BookOpening.tsx`, `login/login.css`)

| Item | Status | Notes |
|------|--------|-------|
| L1 Spine rise | ✅ | `BookSpinesBand` (`shared/motion.tsx`), WAAPI, 700 ms / 30 ms stagger / rise easing, same as the concept |
| L2 Spine lift | ✅ | `shared/components.css` `.qa-spines-band i:hover` |
| L3 Button press | ✅ | `.qa-button:active` `scale(.97)`, 150 ms |
| L4 Card insert | ✅ | `login.css` `.login-card`, 1 s `--ease-page` (= heavy), 122 px. Starts while the request is in flight (`is-reading`) |
| L5 Slot LED | ✅➕ | Also blinks amber while reading and turns red on rejection |
| L6 RFID waves | ✅ | Runs on server acceptance instead of a fixed t+900 ms |
| L7 Welcome line | ✅ | `.login-welcome.is-on`, 500 ms |
| L8 Cover fade-in | ✅ | The whole overlay fades in over 350 ms |
| L9 Book opens | ✅ | `rotateY(-118deg)` over 1300 ms, 750 ms delay, heavy easing; redirects at 2.8 s, with an «进入» button to skip |
| L10 Tile pop | ✅ | 600 ms, delay 1450 + 120 ms × i. The tiles depend on the destination (kiosk or admin) |
| Role tab switch | ➕ | The app adds a `PageTurn` between Reader and staff panels; in the concept they swap instantly |
| RM behaviour | ✅ (better) | Cover hidden, tiles visible, auto-continue after 700 ms. The concept bug in L10 is not copied |

### 2.2 Kiosk home (`kiosk/KioskPage.tsx` `HomeScreen`, `kiosk/kiosk.css`)

| Item | Status | Notes |
|------|--------|-------|
| K1 Page turn between screens | ❌ | `KioskPage` swaps `state.screen` with no transition. `PageTurn` is only used inside the borrow flow and on the login tabs |
| Search bar on home | ❌ | No search field on home. Search exists only in the Reserve flow |
| K2 New-books ticker | ❌ | No ticker or marquee anywhere |
| K3 Service tile rise | ❌ | `.kiosk-action-grid` buttons render without an entrance animation |
| K4 Tile hover lift | 🟡 | A press nudge is used instead: `:active translateY(2px)`, 180 ms. That suits a touch kiosk better than a hover lift |
| «我的借阅» panel on home with K5 row rise | 🟡 | Home shows a 3-number summary instead of the list. The list, with a `StaggerList` row rise, lives on the separate «我的借阅» screen (`LoanFlows.tsx`) |
| K6 Loan count-up | 🟡 | The home summary numbers are static. `CountUp` (700 ms) is used on the Loans screen and the borrow receipt |
| K7 Overdue pulse | 🟡 | `.qa-badge-overdue` pulses (opacity of the halo, 1.8 s) in the loan, return and renew lists. The home «逾期» count only changes colour |
| Idle screen breathing shelf, result check-in pop | ➕ | `kiosk-shelf-breathe` 7 s, `kiosk-check-in` 240 ms |

### 2.3 Borrow flow (`kiosk/BorrowFlow.tsx`, `kiosk/borrow.css`, return part in `kiosk/LoanFlows.tsx`)

| Item | Status | Notes |
|------|--------|-------|
| K8 Stepper | ✅ | Shared `Stepper` with a 300 ms colour transition |
| K1 Page turn between steps | 🟡 | Scan → confirm uses `PageTurn`. Confirm → receipt changes to a separate result screen with no turn |
| K9 Book bob | 🟡 | Replaced by a drop-and-land (`translateY(-26px)` → settle, 600 ms) that runs for each newly placed book |
| K10 Scan line | ✅ | Loops back and forth for as long as the tag is being read (minimum 900 ms), instead of a single sweep |
| K11 Tray rings | ✅ | Same scale and delays; they loop while reading. RM shows one static ring |
| K12 Catalog drawer | ✅ | `CatalogDrawer`: 900 ms spring to open, 480 ms heavy to close, interruptible; works with several cards |
| K13 Receipt print | ✅ | `translateY(-100%)` → 0 with `steps(14)` over 1600 ms, from a printer mouth (same effect as the concept's `max-height`) |
| K14 Stamp | ✅ | 400 ms at 1.5 s; reads «待同步» when offline. Under RM it stays visible (the concept bug is not copied) |
| K15 Bookmark ribbon | ✅ | `BookmarkRibbon`, 900 ms bounce, delay 1.2 s |
| Count-up after receipt | ➕ | «我的借阅» `CountUp` (900 ms) appears at 2.1 s |
| K16 Route march (return) | ✅ | `ShelfRouteMap`, CSS `stroke-dashoffset` loop. Stopped under RM, which the concept's SMIL version could not do |
| K17 Walker dot | ✅ | SMIL `animateMotion`, but only rendered when RM is off (`usePrefersReducedMotion`) |
| K18 Target shelf pulse | ✅ (fixed) | The app pulses opacity, which works on SVG; the concept's `box-shadow` did not |
| Return pad rings | ➕ | `kiosk-return-ring` 2.2 s loop |

### 2.4 Admin shell (`admin/AdminPage.tsx`, `admin/admin.css`, `shared/components.tsx`)

| Item | Status | Notes |
|------|--------|-------|
| Burgundy sidebar, active link with blush background and wood border | ✅ | `.admin-drawer-link.active` |
| A4 Sidebar hover slide | ✅ | 200 ms transition on background and `padding-left: 14px` |
| A7 Bell ring | ✅ | `admin-ring` 800 ms, same keyframes. Fired by a real `alert.raised` server-sent event, not a button; `BellIcon key={ring}` restarts the animation |
| Badge count | ✅ | `.admin-bell em` |
| A8 Alert toast | ✅➕ | `Toast`: 450 ms spring drop from −90 px, plus its own 260 ms exit; stacked by `ToastProvider` |
| «模拟告警» button in the header | 🟡 | Not in the header. Alerts are simulated from the Simulator page |
| Command palette, wallboard motion | ➕ | Palette 220 ms drop-in. Wallboard has live pulses, critical blinks and flashes |

### 2.5 Books table (`admin/ListPages.tsx` `BooksPage`, `admin/adminUi.tsx`, `shared/components.tsx` `DataTable` / `Drawer`)

| Item | Status | Notes |
|------|--------|-------|
| A2 Row wave | ✅ | `DataTable` `useStagger`: 450 ms, 60 ms step, 12 px rise (concept: 18 px). Replays when rows change |
| A3 Row hover / selected tint | ✅ | `.qa-table tr.is-clickable:hover`, plus `.is-selected` |
| A5 Filter chips | 🟡 | 200 ms transition is present. The filter set is all / on_shelf / borrowed / repair / lost: «逾期» is missing because overdue is a loan status, not a book status. Changing the filter does not close the drawer |
| A6 Book card drawer | ✅➕ | `Drawer`, 450 ms `--ease-out` slide. Adds a `CatalogCard` and a loaded history `Timeline`; the last selection stays rendered while the drawer closes |
| A1 KPI count-up above the table | 🟡 | `CountUp` (1200 ms, ease-out cubic, IntersectionObserver .3) plus a `StaggerList` exist on the Overview page, not on the Books page |
| A9 Overdue pulse in the table | 🟡 | Not on Books (books have no overdue status). On the Loans page, overdue rows use the pulsing `StatusBadge` |
| Search box in the toolbar | ➕ | Not in the concept |

## 3. Notes for follow-up

- **Gap list, in priority order:** K1 page turn between kiosk screens · K3 tile rise · K2 ticker and home search · home loan list with K6 count-up and K7 pulse · KPI strip and «逾期» filter on Books.
- **Token naming:** `--ease-page` in `styles.css` is the *heavy* curve `(.6,.05,.2,1)`, while `easing.page` in `motion.tsx` is `(.2,.8,.2,1)`. The values are correct where they are used, but the two names point at different curves.
- **Reduced motion:** the app is stricter than the concept. It has a global clamp in `styles.css`, `animate()` returns early, and the remaining SMIL is gated by a hook. Do not port the concept's RM block as-is: it would hide the L10 tiles and the K14 stamp, and it leaves K16–K17 running.
