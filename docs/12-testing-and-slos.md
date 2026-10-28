# Testing and SLOs

## Test strategy per layer

| Layer | Tooling | What |
| --- | --- | --- |
| Pure logic (shared) | Vitest (NestJS 12 packages are ESM-only; Jest needs Node 24.9+, [R-13](references.md)) | Dose expansion, delay resolution, window/budget allocator, code alphabet/normalisation, answer merge rules |
| API unit | Vitest + Nest testing module | Services, guards (JWT vs device), idempotency interceptor, error mapping |
| API integration | Vitest + real PostgreSQL 18 + Redis in containers | Transactions, `FOR UPDATE SKIP LOCKED`, partial indexes used (`EXPLAIN`), quota locking, pairing redeem, webhook dedupe |
| Contract | OpenAPI generated from Nest; app client generated from it; contract tests in CI | Request/response shapes match [04](04-api.md) |
| Mobile unit | Jest via `jest-expo` (check the current Expo testing docs before setup) | Scheduler reconciliation, outbox, mode switch, i18n keys present |
| Mobile E2E | Maestro or Detox (choose in Phase 1 after checking current docs) | Pairing, Today screen answers, permission onboarding |
| Device (manual + scripted) | Physical device matrix below | Alarms with app killed, locked, overnight, battery saver |

### Dose generation tests
(Phase 2 gate: "generated doses match the schedule across timezones and DST")
- Property tests: for random schedules (daily / weekdays / every N days, 1–6 times/day, start/end dates), timezones (`Asia/Kolkata`, `America/New_York`, `Europe/London`, `Australia/Lord_Howe` (30-min DST), `Pacific/Chatham`), and windows spanning DST transitions:
  - every generated dose has the scheduled **local** wall-clock time (DST never moves it, [D-034](01-decisions.md#d-034-dose-generation));
  - no duplicates (`medicine_id, scheduled_at`);
  - gap and overlap handled per [D-086](01-decisions.md#d-086-dst-timezone-source-and-delay-changes);
  - every-N-days cycle anchored on `start_date` across edits.
- Edit regeneration: only future `pending` rows change; answered/missed rows are untouched.
- Timezone change regenerates future doses only.

### Isolation tests
Seed two caregivers (A, B), each with patients, medicines, doses, devices and photos. For **every** endpoint in [04](04-api.md), call as A against B's IDs → `404`. Call as a device of patient P1 against P2 → `404`. Generated from the route table, so new endpoints are covered automatically. CI fails if a route is missing from the matrix.

### Reminder engine tests
- Sweeper: concurrent workers (N = 4) over 10k due rows → each row processed exactly once; restart mid-batch → no loss, no duplicates.
- Conditional push truth table: (`scheduled_through`, `last_seen_at`, permissions) → push or not ([D-036](01-decisions.md#d-036-conditional-push-backup)).
- Missed alert at `alert_due_at`; snooze never moves it; grouping within 15 min replaces rather than adds; Not taken immediate; correction after missed.
- Device-health throttle: at most one per 12 h per device.
- Delay change recomputes `alert_due_at` only for pending/snoozed doses scheduled after the change (D-086).
- Answer merge: clamped `responded_at`, tie by `received_at`; snooze refused when under 10 min remain (D-085).
- Budget allocator: profiles share 60 slots; over budget → follow-ups only for the next 24 h (D-078).
- Pairing: 4th active device refused; wrong code on a live lookup ID increments that code's failures, 5 → locked (D-084).
- Grace: dose windows issued during grace end at `cutoff_at` (D-087).
- Auth: login failure is indistinguishable (status, body, timing) for unknown email vs wrong password; throttling per account and per IP; 7- and 129-character passwords rejected, 8 and 128 accepted (D-096); password never appears in logs or Sentry events (D-095).
- Billing: grace warnings at expiry and at −6 h; cutoff suspends all patients and the self profile; renewal restores and regenerates.

## Device matrix

([D-068](01-decisions.md#d-068-phases-and-gates)) Four physical phones:

| Phone | Why |
| --- | --- |
| Samsung (One UI) | Largest Android share; aggressive "sleeping apps" |
| Xiaomi (HyperOS/MIUI) **or** Oppo (ColorOS) | Strict OEM background killers |
| Stock Android (Pixel) | Reference behaviour, latest Android |
| iPhone | iOS limits, time-sensitive, actions while terminated |

Each run in three states: **locked**, **idle overnight** (≥ 8 h untouched, unplugged, so Doze engages), and **battery saver on**. Record OS version, app build and results in the roadmap gate entry.

### Device test script (per phone, per state)
1. Pair, finish onboarding, schedule test doses: Standard, Alarm (30-min delay), Gentle; two doses 1 minute apart; one at 03:00.
2. Kill the app (swipe away), lock, leave.
3. Verify: each notification fired within 1 minute of time; Alarm follow-ups every 5 minutes; lock-screen Taken/Not taken/Snooze recorded and synced on next network; missed alert to the caregiver phone at the deadline.
4. Repeat offline (airplane mode during answers, network back later).

## Chaos cases

| Case | Expectation |
| --- | --- |
| Kill Redis for 10 min, then restore empty | No lost alerts; sweeper resumes; alerts late by ≤ outage; Job Schedulers re-created |
| Kill all workers mid-sweep | Rows processed once after restart; `queued` outbox rows sent |
| Postgres failover | API errors briefly; no duplicate alerts after recovery |
| Expo Push returns 5xx/429 for 15 min | Outbox retries with backoff; nothing dropped |
| Duplicate and out-of-order RevenueCat webhooks | State converges to the RevenueCat customer state |
| Patient phone offline 3 days, answers queued | All answers synced within 5 min of network; corrections sent for missed ones |
| Revoke a device while it has alarms scheduled | Alarms keep firing; recovery screen on next call; caregiver alerted |
| Clock set 2 h ahead on patient phone | Server times correct; skew warning; answer clamping per D-085 |
| Exact-alarm permission revoked while window scheduled | Device alert to caregiver; reschedule on next run; backup pushes |
| Subscription expires, phone offline at cutoff | Phone shows paused on next sync; no alarms past cutoff if it synced during grace (D-087) |

## SLOs

Proposed targets ([D-069](01-decisions.md#d-069-proposed-slos)):

| SLO | Target | Measurement |
| --- | --- | --- |
| Missed-dose alert timeliness | **99.9%** of missed alerts sent within **2 min** of due time (`alert_due_at`) | Per alert: `notification_log.sent_at − dose.alert_due_at` (send = accepted ticket from Expo). Monthly window. Excludes suspended patients |
| Sweeper lag | **p99 < 60 s** | Each run emits `now() − min(alert_due_at or scheduled_at)` of rows still unprocessed at run start; p99 over 1-minute samples, 30-day window |
| Device health | **98%** of active patient devices healthy: permissions on, heartbeat < 6 h, window ≥ 2 days | Hourly snapshot over devices of `active` patients with doses in the next 24 h; health = same rules as [09](09-missed-dose-alerts.md#device-problem-alerts) plus `scheduled_through ≥ now() + 2 days` |
| Offline answer delivery | **99%** of offline answers reach the server within **5 min** of the network returning | App records `network_restored_at` per queued answer and sends it with the answer; server computes `received_at − network_restored_at` |
| Stability | **99.5%** crash-free sessions | Sentry release health (app); per release |

Error budgets are reviewed weekly from Phase 4 onwards. A breached alert-timeliness budget freezes feature work until fixed.
