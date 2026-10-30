# Testing and SLOs

## Test strategy per layer

| Layer | Tooling | What |
| --- | --- | --- |
| Pure logic (shared) | Vitest (NestJS 12 packages are ESM-only; Jest needs Node 24.9+, [R-13](references.md)) | Dose expansion, delay resolution, window/budget allocator, code alphabet/normalisation, answer merge rules |
| API unit | Vitest + Nest testing module | Services, guards (JWT vs device), idempotency interceptor, error mapping |
| API integration | Vitest + real PostgreSQL 18 + Redis in containers | Transactions, `FOR UPDATE SKIP LOCKED`, partial indexes used (`EXPLAIN`), quota locking, pairing redeem, webhook dedupe |
| Mobile unit | Jest via `jest-expo` (check the current Expo testing docs before setup) | Scheduler reconciliation, outbox, mode switch, i18n keys present |
| Device (manual) | One real Android phone, checklist below | Alarms with app killed, locked, overnight |

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

Implemented as `apps/api/src/testing/isolation.int-spec.ts`: the route list is read from the running app (`routes.ts`), every route must appear in the matrix (kind `public`, `device`, `self` or `scoped`) or the test fails, every non-public route must answer `401` with no credentials, caregiver and device tokens must not be interchangeable, and every `scoped` route answers one uniform `404` to A for B's IDs, to a random ID and to a malformed ID alike. It found a `500` on a malformed device ID in `POST /v1/devices/:id/revoke`. CI runs it (`.github/workflows/ci.yml`).

### Reminder engine tests
- Sweeper: concurrent workers (N = 4) over 10k due rows → each row processed exactly once; restart mid-batch → no loss, no duplicates.
- Conditional push truth table: (`scheduled_through`, `last_seen_at`, permissions) → push or not ([D-036](01-decisions.md#d-036-conditional-push-backup)).
- Missed alert at `alert_due_at`; snooze never moves it; grouping within 15 min replaces rather than adds; Not taken immediate; correction after missed.
- Device-health throttle: at most one per 12 h per device.
- Redis wiped and restored empty: Job Schedulers re-created on worker boot, sweeper resumes, no lost alert (D-033, D-071).
- Delay change recomputes `alert_due_at` only for pending/snoozed doses scheduled after the change (D-086).
- Answer merge: clamped `responded_at`, tie by `received_at`; snooze refused when under 10 min remain (D-085).
- Budget allocator: profiles share 60 slots; over budget → follow-ups only for the next 24 h (D-078).
- Pairing: 4th active device refused; wrong code on a live lookup ID increments that code's failures, 5 → locked (D-084).
- Grace: dose windows issued during grace end at `cutoff_at` (D-087).
- Auth: login failure is indistinguishable (status, body, timing) for unknown email vs wrong password; throttling per account and per IP; 7- and 129-character passwords rejected, 8 and 128 accepted (D-096); password never appears in logs or Sentry events (D-095).
- Billing: grace warnings at expiry and at −6 h; cutoff suspends all patients and the self profile; renewal restores and regenerates.

## Device checks

([D-097](01-decisions.md#d-097-no-phase-0-spike-fewer-tests-reliability-checked-in-phase-3)) The four-phone matrix and the chaos table were dropped. Cases that mattered are unit or integration tests above.

**Phase 3, one real Android phone** (checklist in [13](13-roadmap.md#phase-3--reminders)):
1. Pair, finish onboarding, schedule test doses: Standard, Alarm (30-min delay), Gentle; two doses 1 minute apart.
2. Kill the app (swipe away), lock, leave. Once overnight, unplugged.
3. Verify: each notification fired within 1 minute; Alarm follow-ups every 5 minutes; lock-screen Taken / Not taken / Snooze recorded and synced on next network; missed alert reached the caregiver phone at the deadline.
4. Repeat once offline (airplane mode while answering, network back later).

**Phase 5:** repeat on the beta group's own phones during the one-week beta; add Samsung / Xiaomi / Oppo only if someone in the group has one. **iPhone:** only when one exists (OI-29).

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
