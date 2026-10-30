# Roadmap

Phases 1–5 ([D-068](01-decisions.md#d-068-phases-and-gates), Phase 0 dropped by D-097). A phase is done only when its **exit gate** passes; record the result (date, devices, build) under the gate. Resolve the listed conflicts before starting the phase.

Every phase starts by re-reading the official docs for the libraries it touches and updating [references.md](references.md) ([CLAUDE.md](../CLAUDE.md)).

---

## Phase 0 — dropped ([D-097](01-decisions.md#d-097-no-phase-0-spike-fewer-tests-reliability-checked-in-phase-3))

The reminder spike is removed; work starts at Phase 1. Its reliability checks moved to Phase 3, and its docs re-check is done (2026-10-28: R-02, R-03, R-49–R-55; no notification/alarm changes in Android 16/17, none listed by Apple for iOS 26).

---

## Phase 1 — Foundations

**Goal:** Accounts, schema, plan quota, pairing codes and QR.

**Depends on:** [02](02-architecture.md), [03](03-data-model.md), [04 auth/patients/pairing/devices](04-api.md), [06](06-pairing-and-devices.md), [07 quota](07-subscriptions-and-billing.md#quota-enforcement), [10](10-security-privacy.md). **Implements:** D-071, D-080, D-082, D-083, D-084, D-089, D-092, D-095, D-096.

- [ ] Monorepo: `apps/mobile` (Expo SDK 58), `apps/api` (NestJS 12, Node 26 LTS), shared types
- [ ] Re-check NestJS, Drizzle, BullMQ, Redis minimum version docs; record in references
- [ ] Postgres 18 + Drizzle schema and migrations for all tables in [03](03-data-model.md) (including the D-082 additions)
- [ ] Field-level encryption helper + key management
- [ ] Idempotency-Key interceptor + `idempotency_keys` table
- [ ] Error format and codes per [04](04-api.md#errors)
- [ ] Auth: email + password register/login (Argon2id + pepper, 8–128 chars, generic errors, per-account and per-IP throttling), refresh rotation, logout (D-095)
- [ ] One active caregiver login: session replacement + "signed in elsewhere" notice
- [ ] `caregiver_settings` with defaults (30 min, full, false)
- [ ] Subscriptions table + server-side entitlement check stub; Starter = 3
- [ ] Patients CRUD + archive/reactivate with quota check under row lock
- [ ] Self profile creation (one per caregiver; subscription required)
- [ ] Pairing code generation (31-symbol alphabet, `XXXX-XXXX`, QR), 10 min, single use, supersede, hash only
- [ ] Redeem transaction with 5-attempt lock, rate limits (IP/device/global), device limit 3
- [ ] Optional attestation via `@expo/app-integrity` in log-only mode
- [ ] Device token issue/hash/rotate; `Device` auth guard; revoke endpoint
- [ ] Patient app: scan/type code, consent screen, secure-store token (`AFTER_FIRST_UNLOCK`), rejected-token screen
- [ ] Caregiver app: generate code screen, "Patient connected on …", Revoke, Re-pair
- [ ] Audit log writes for pairing, revoke, patient changes
- [ ] Isolation test harness (route matrix) in CI
- [ ] i18n setup: all strings in `en` translation files; lint rule for raw strings
- [ ] Sentry in app and API with scrubbing + a test asserting no PII in events
- [ ] `GET /v1/app/config` with minimum version

**Exit gate:** a real phone pairs with a code and a revoked device is refused.
> Gate result: _not run_

---

## Phase 2 — Medicines and doses

**Goal:** Medicine CRUD, photos, schedule versions, dose generation.

**Depends on:** [03](03-data-model.md), [04 medicines/uploads/history](04-api.md#medicines), [05 dose generation](05-reminder-engine.md#dose-generation), [10 photos](10-security-privacy.md#photos). **Implements:** D-082, D-086, D-091.

- [ ] Medicine create/update/archive; update closes version, opens new effective now
- [ ] Schedule patterns: daily, weekdays, every N days; multiple times with own amount; start/end date
- [ ] Name/amount snapshots on doses; archive never deletes
- [ ] Photo: pick, resize/compress, EXIF removal verified, presign `PUT` to private R2, server `HEAD` check, size cap
- [ ] Signed read URLs for owner and paired devices only; access audited
- [ ] Dose generator Job Scheduler (daily) + on-demand regeneration (edit, archive, tz change)
- [ ] `alert_due_at` frozen at generation via delay resolution medicine → patient → default
- [ ] History and adherence endpoints (read-only for suspended)
- [ ] Caregiver UI: medicine list/form, schedule editor, photo, history
- [ ] Property tests across timezones and DST ([12](12-testing-and-slos.md#dose-generation-tests))

**Exit gate:** generated doses match the schedule across timezones and DST.
> Gate result: _not run_

---

## Phase 3 — Reminders

**Goal:** Local alarms from server windows, conditional push, answers and sync.

**Depends on:** [05](05-reminder-engine.md), [08](08-notifications-and-platform.md), [04 device sync](04-api.md#device-sync-and-answers). **Implements:** D-072, D-075, D-076, D-077, D-078, D-079, D-085, D-086, D-093, D-094.

- [ ] `GET /v1/device/sync` with cursor, window sizing per platform, photo URLs, `account_state`, `commands`
- [ ] Phone scheduler: budget allocator across profiles, reconcile by dose ID, `scheduled_through`
- [ ] Notification types → channels / interruption levels; lock-screen detail full/generic
- [ ] Mandatory guided permission onboarding; skipped permissions reported
- [ ] Heartbeat on open, background task and sync; device fields updated
- [ ] Today screen: large buttons, photo, amount; works without notification permission
- [ ] Lock-screen actions → SQLite outbox → batch `dose-responses` with `client_event_id`
- [ ] Server answer rules: earliest wins, snooze limits, corrections hook, `dose_cleared` data push
- [ ] Sweeper Pass A: conditional backup push with outbox in `notification_log`
- [ ] Expo push sender (chunks ≤ 100, backoff) + receipts job (`DeviceNotRegistered` handling)
- [ ] Refill: app open, `expo-background-task`, Android data push; visible push when window < 24 h
- [ ] Timezone follow-device: regenerate + caregiver notice
- [ ] Reliability checks on one real Android phone, app killed, build from EAS (formerly Phase 0, D-097):
  - Lock-screen Taken / Not taken / Snooze are saved with the app killed (`registerTaskAsync`, D-076), then sent on the next network
  - Alarm follow-ups every 5 min with `delivery: 'alarmClock'` in forced Doze (`adb shell dumpsys deviceidle force-idle`); also check whether Standard/Gentle need it for doses within 9 min (D-072)
  - Exact-alarm grant and revoke: status flips and the window re-schedules (D-073); CI check that the merged manifest has no `USE_EXACT_ALARM`
  - Battery-optimisation settings screen opens and the state is read via `expo-battery` (D-074)
  - Android data push to a killed app: delivered count recorded (D-075, best effort)
  - One overnight run: unplugged, locked, app killed; all doses fire within 1 min
- [ ] If an iPhone becomes available: iOS lock-screen answers with the app killed (D-076), 64-request limit (D-078), time-sensitive with Focus, photo attachment (D-079). Otherwise OI-29 stays open

**Exit gate:** test doses fire on a locked, idle Android phone with the app killed, online and offline, including one overnight run. (iPhone half pending OI-29.)
> Gate result: _not run_

---

## Phase 4 — Alerts and billing

**Goal:** Missed alerts, device health, transfer, subscriptions.

**Depends on:** [09](09-missed-dose-alerts.md), [07](07-subscriptions-and-billing.md), [06 transfer](06-pairing-and-devices.md#transfer). **Resolve first:** OI-01 (plans, prices, trial). **Implements:** D-082, D-087, D-092, D-093.

- [ ] Sweeper Pass B: missed alerts at `alert_due_at`, mark `missed` + `alert_sent_at` in one transaction
- [ ] Grouping within 15 min via `group_key` / collapse ID
- [ ] Not taken immediate alert; corrections for late answers; self profile once-only rule
- [ ] Device-health job: 6 h heartbeat, permissions, window < 24 h, invalid push token; 12 h throttle
- [ ] Transfer code + redeem (quota, `as_self`), everything moves intact, both sides audited
- [ ] RevenueCat SDK in app; paywall; `subscription/refresh`
- [ ] Webhook endpoint: auth header/HMAC, event-ID dedupe, async re-fetch via API v2
- [ ] Daily reconciliation job
- [ ] Store grace periods enabled in Play Console and App Store Connect
- [ ] 1-day grace: warnings at expiry and −6 h; patient banner
- [ ] Cutoff (sweeper Pass C): suspend patients + self profile, `cancel_all`, "Reminders paused"
- [ ] Suspended read-only enforcement; renewal restore + re-sync within a minute
- [ ] Dashboards: sweeper lag, push receipts, device health ([14](14-release-and-ops.md#monitoring))

**Exit gate:** a missed dose alerts the caregiver once, at the configured delay.
> Gate result: _not run_

---

## Phase 5 — Hardening and launch

**Goal:** OEM reliability, security, compliance, store approval, real-world beta.

**Depends on:** [10](10-security-privacy.md), [11](11-failure-modes.md), [12](12-testing-and-slos.md), [14](14-release-and-ops.md), [08 store checklist](08-notifications-and-platform.md#store-policy-checklist). **Resolve first:** C-10 (legal review), OI-18 (retention), OI-19 (grievance contact). **Implements:** D-073, D-074, D-077, D-081, D-088, D-090.

- [ ] Re-check every reference older than 3 months; update versions
- [ ] OEM battery checks on the beta group's own phones (Samsung, Xiaomi/Oppo if present) + OEM guidance screens
- [ ] Security review: auth, pairing abuse, isolation, scrubbing, secrets, dependency audit
- [ ] PITR restore drill passed ([14](14-release-and-ops.md#restore-drill))
- [ ] DPDP: consent flows, notice, export, in-app deletion, grievance contact, retention rules; legal review sign-off (C-10)
- [ ] Disclaimer screens (reminder tool, not medical advice; consult a doctor)
- [ ] Store listings, privacy policy, Play Data safety, Health apps declaration, App Store privacy details
- [ ] Play exact-alarm justification (D-073); OEM battery guidance screens (D-074)
- [ ] EAS channels, staged rollout plan, minimum-version check tested ([14](14-release-and-ops.md))
- [ ] Beta group on real medicines for a full week; SLO dashboard review
- [ ] Submit to Play and App Store
- [ ] After launch: apply for Apple Critical Alerts entitlement

**Exit gate:** store review passed and a beta group has run a full week of real doses.
> Gate result: _not run_

---

## v1.1 (later)

([D-070](01-decisions.md#d-070-later-v11))
- [ ] Pill stock count with low-stock alert to the caregiver (`medicines.stock_count`, `low_stock_at`; `PATCH /v1/medicines/{id}/stock`)
- [ ] Evening adherence summary (`caregiver_settings.daily_summary`)
- [ ] Read-aloud of medicine name
- [ ] More languages (translation files already in place)
- [ ] Email verification, email OTP sign-in, Google sign-in and Sign in with Apple, shipped together (Apple 4.8) (D-095); re-check current provider docs first
