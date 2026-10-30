# Decision log

The source of truth for product and engineering behaviour. Every other doc must agree with this file. To change a decision, add a new entry that supersedes the old one; never edit history silently.

- **Date:** D-097 is an owner change of 2026-10-30. D-001 to D-070 were agreed on 2026-10-25, before documentation started. D-071 to D-094 resolve the conflicts and open items found while documenting, accepted 2026-10-28 ([Resolutions](#resolutions-2026-10-28)). D-095 onwards are later owner changes ([Owner changes](#owner-changes)).
- **Status values:** `Accepted`, `Recommended` (agreed in principle, optional for v1), `Deferred (v1.1)`, `Open`, `Superseded by D-xxx`. "Amended by D-xxx" means a later entry adds rules or changes wording; read both.
- An entry still marked **⚠ C-xx** has an unresolved conflict with current official documentation ([Conflicts found while documenting](#conflicts-found-while-documenting)). The owner must resolve it before the phase that implements it.

## Platform and scope

### D-001 Expo development build, one app with two modes
- **Decision:** Build with Expo as a development build (not Expo Go). One app holds two modes, **caregiver** and **patient**, which can run side by side on the same phone.
- **Reason:** Reliable reminders need native config (channels, exact alarms, background tasks, entitlements) that Expo Go cannot carry; remote push on Android is not available in Expo Go ([R-02], [R-07]).
- **Status:** Accepted

### D-002 In-app only, no SMS/call/email fallback
- **Decision:** Every interaction happens inside the app with notification permissions granted. No SMS, call or email fallback.
- **Reason:** Keeps scope, cost and compliance small; reliability is achieved with local alarms plus push backup.
- **Status:** Accepted · amended by D-077

### D-003 English only, strings externalised
- **Decision:** English only at launch. All user-facing strings live in translation files from day one.
- **Reason:** More languages are planned (v1.1); retrofitting i18n is expensive.
- **Status:** Accepted

### D-004 No drug database
- **Decision:** No drug database and no interaction checks. Medicine names are free text.
- **Reason:** Avoids medical-device scope and licensing.
- **Status:** Accepted

### D-005 Disclaimer
- **Decision:** The app is a reminder tool, not medical advice, and shows a disclaimer.
- **Reason:** Liability; Apple guideline 1.4.1 asks medical apps to remind users to check with a doctor ([R-42]).
- **Status:** Accepted

## Roles and notifications

### D-006 Only owner caregiver and patient are notified
- **Decision:** Only two parties are ever notified about a patient: the caregiver who owns the patient and the patient. No family-wide fan-out.
- **Reason:** Simplicity and privacy.
- **Status:** Accepted

### D-007 One owner per patient
- **Decision:** A patient has exactly one owner caregiver at a time.
- **Reason:** Clear accountability, quota and billing.
- **Status:** Accepted

### D-008 Self profile
- **Decision:** A caregiver can track their own medicines as a **self profile** on their own phone. It never counts toward the plan's patient limit, but still requires an active subscription and stops when the subscription lapses.
- **Reason:** Otherwise one device could use the app free forever.
- **Status:** Accepted · amended by D-092

### D-009 Dual roles on one phone
- **Decision:** One phone can hold a caregiver account and a paired patient profile at the same time.
- **Reason:** Family members often both take and manage medicines.
- **Status:** Accepted · amended by D-078

## Pairing

### D-010 Pairing code format
- **Decision:** Caregiver taps *Generate code*; the app shows an 8-character code from a 31-symbol alphabet without look-alikes (no 0/O, 1/I/L), formatted `XXXX-XXXX`, plus a QR code.
- **Reason:** Easy to read aloud or type; QR for in-person handover.
- **Status:** Accepted

### D-011 Pairing code lifetime and storage
- **Decision:** Valid **10 minutes**, single use; a new code invalidates the previous one for that patient. Only a hash is stored.
- **Reason:** Limits the window for misuse; a DB leak exposes no usable codes.
- **Status:** Accepted

### D-012 Pairing abuse controls
- **Decision:** Rate limited per IP, per device and globally; **5 failed attempts** lock the code; a spike in global failures pages the owner.
- **Reason:** 31⁸ ≈ 8.5 × 10¹¹ codes is safe only with rate limits.
- **Status:** Accepted · limits set by D-084

### D-013 Device attestation on redeem
- **Decision:** Use Play Integrity (Android) and App Attest (iOS) on the redeem call.
- **Reason:** Raises the cost of scripted guessing. Available through `@expo/app-integrity` ([R-06], [R-35], [R-41]).
- **Status:** Recommended

### D-014 Patient device token
- **Decision:** On redeem the server issues a long-lived device token stored in Keychain/Keystore (secure store), hashed server-side, scoped to one patient, revocable, rotated on re-pair.
- **Reason:** Patients never sign in; the token is their only credential.
- **Status:** Accepted

### D-015 Rejected token
- **Decision:** If the token is rejected, the patient sees one screen ("Ask your caregiver for a new code") and the caregiver is alerted; local alarms already scheduled keep firing.
- **Reason:** A broken credential must not silence reminders already on the phone.
- **Status:** Accepted

### D-016 Pairing confirmation
- **Decision:** The caregiver immediately sees "Patient connected on [device, time]" with **Revoke** and **Re-pair**.
- **Reason:** Detects a wrong person redeeming the code.
- **Status:** Accepted

### D-017 First redeemer wins
- **Decision:** Whoever redeems first becomes the patient, so the code is handed over in person or in a trusted chat.
- **Reason:** Accepted tradeoff for an OTP-free, AnyDesk-style flow.
- **Status:** Accepted

## Devices and logins

### D-018 Up to 3 patient devices
- **Decision:** A patient can use **up to 3 active devices**, each paired with its own code. An answer on one device sends a data push that clears that dose on the others.
- **Reason:** Phone + tablet + spare phone are common.
- **Status:** Accepted · amended by D-075, D-084

### D-019 One caregiver login
- **Decision:** A caregiver account has **one active login** at a time. Signing in on a new phone signs out the old one with a notice. No limit on device switches.
- **Reason:** Missed-dose alerts must have one clear destination; prevents account sharing.
- **Status:** Accepted

## Medicines and schedules

### D-020 Medicine fields
- **Decision:** Name, notes, optional reference photo, notification type, optional missed-dose delay, optional stock count (stock tracking ships in v1.1).
- **Status:** Accepted

### D-021 Schedule patterns
- **Decision:** Daily, chosen weekdays, or every N days. Several times per day, each with its own amount (for example 08:00 "1 tablet", 21:00 "2 tablets").
- **Status:** Accepted

### D-022 Start and end dates
- **Decision:** Start date and optional end date. No end date = the medicine runs as long as the subscription is active.
- **Status:** Accepted

### D-023 Schedule versions, snapshots, archive
- **Decision:** Editing a medicine closes the current schedule version and opens a new one effective from now. Each dose stores a snapshot of the medicine name and amount. Medicines are archived, never hard-deleted.
- **Reason:** History stays truthful after edits.
- **Status:** Accepted

### D-024 Photos
- **Decision:** Private Cloudflare R2 bucket, presigned upload, EXIF stripped, compressed on the phone, size capped, short-lived signed read URLs only for the owner and the paired patient, cached on the patient's phone for offline display.
- **Status:** Accepted · size cap set by D-091

## Notification types

### D-025 Three notification types
- **Decision:** **Standard** (default), **Alarm** (loud; local follow-ups every **5 minutes** until answered or the missed delay ends), **Gentle**. Stored as `standard`, `alarm`, `gentle`.
- **Status:** Accepted · amended by D-072, D-094

### D-026 Android channels
- **Decision:** One notification channel per type, created at install. Channel settings cannot change after creation, so channel IDs are versioned.
- **Reason:** Confirmed: only name and description can change after creation ([R-02], [R-30]).
- **Status:** Accepted

### D-027 iOS interruption levels
- **Decision:** Time-sensitive interruption level for Standard and Alarm. Apply for Apple's Critical Alerts entitlement after launch.
- **Status:** Accepted

### D-028 Lock-screen detail
- **Decision:** The lock screen shows as much detail as the OS allows (medicine name, amount, time, photo). The caregiver can switch a patient to generic text.
- **Status:** Accepted · amended by D-077, D-079

## Patient answers

### D-029 Answer options
- **Decision:** **Taken**, **Not taken**, **Snooze 10 min**. Available as lock-screen notification actions and on a large-button Today screen showing photo and amount.
- **Status:** Accepted · amended by D-076

### D-030 Snooze limits
- **Decision:** Snooze is allowed only before the missed delay ends and never extends it.
- **Status:** Accepted · edge case set by D-085

### D-031 Offline-first answers
- **Decision:** Answers are written to local SQLite first and synced in batches with a client-generated `client_event_id`. The earliest answer wins; device time (`responded_at`) and server time (`received_at`) are both kept.
- **Status:** Accepted · merge rule set by D-085

### D-032 Late answers
- **Decision:** A patient can still answer a missed dose; the status flips and the caregiver gets a short correction.
- **Status:** Accepted

## Reminder engine

### D-033 Postgres is the source of truth
- **Decision:** Postgres is the source of truth for every dose and alert. Redis only runs BullMQ repeatable jobs; losing Redis loses no reminder.
- **Status:** Accepted · amended by D-071

### D-034 Dose generation
- **Decision:** A daily job expands schedule versions into `dose_instances` **14 days** ahead in the patient's timezone (DST never moves the local clock time). Edits regenerate only future pending doses.
- **Status:** Accepted · DST rule set by D-086

### D-035 Phone never computes doses
- **Decision:** The phone schedules local notifications only from server-issued dose instances, using the dose ID as the notification identifier, so re-syncs replace instead of duplicating.
- **Status:** Accepted

### D-036 Conditional push backup
- **Decision:** Each heartbeat reports `scheduled_through`. The server pushes a due dose only when it lies beyond that point, the device has not checked in for **12 hours**, or a required permission is off. Healthy phones never get a duplicate.
- **Status:** Accepted

### D-037 Minute sweeper
- **Decision:** A BullMQ repeatable job every minute selects due rows with `FOR UPDATE SKIP LOCKED` on a partial index and sets `push_sent_at` / `alert_sent_at` in the same transaction. Idempotent; worker or Redis restarts drop nothing.
- **Status:** Accepted · amended by D-071

### D-038 Window size
- **Decision:** iOS holds at most 64 pending local notifications. Window days = 60 ÷ notification slots per day (dose, repeat, Alarm follow-ups each take one), minimum 2 days. Android: 5 days.
- **Reason:** 64 confirmed by Apple staff (Jan 2026) but not in Apple's reference docs ([R-38], [R-39]); 4 slots stay in reserve.
- **Status:** Accepted · amended by D-078

### D-039 Refill paths
- **Decision:** Refill on app open, from a background task, and by high-priority data push on Android. iOS silent push is a bonus only. When the window drops below **24 hours**, send a visible push ("Open the app to keep reminders on schedule") and warn the caregiver.
- **Status:** Accepted · amended by D-075, D-093

### D-040 Timezone
- **Decision:** Doses follow the phone's current timezone (reported in the heartbeat) unless the caregiver pins a fixed one; a change regenerates future doses and tells the caregiver.
- **Status:** Accepted · timezone source set by D-086

### D-041 Heartbeat
- **Decision:** Sent on app open, from the background task and with every sync: push token, permissions, exact-alarm and battery-whitelist state, app version, timezone, `scheduled_through`.
- **Status:** Accepted

### D-042 Mandatory guided patient setup
- **Decision:** First-run patient setup is a mandatory guided step: notifications, exact alarms and battery whitelisting on Android, time-sensitive notifications on iOS. Each skipped permission is reported to the caregiver.
- **Status:** Accepted · amended by D-073, D-074, D-077

## Missed-dose alerts

### D-043 Missed delay and resolution order
- **Decision:** Default delay **30 minutes**, set in app settings. Override per patient and per medicine. Resolution order: medicine → patient → app default.
- **Status:** Accepted

### D-044 Missed alert
- **Decision:** The sweeper finds pending or snoozed doses past `scheduled_at + delay` with no `alert_sent_at`, marks them missed and pushes every caregiver device: "No answer recorded for [medicine, amount] at [time]" (never claims Not taken, since the patient may be offline).
- **Status:** Accepted · amended by D-077

### D-045 Not taken alert
- **Decision:** A **Not taken** answer alerts the caregiver immediately.
- **Status:** Accepted

### D-046 Grouping
- **Decision:** Several misses for one patient within **15 minutes** arrive as one grouped alert.
- **Status:** Accepted

### D-047 Device problem alert
- **Decision:** A separate alert when: no heartbeat for **6 hours** while doses are scheduled, a required permission is off, or the window is under 24 hours. At most one per **12 hours** per device.
- **Status:** Accepted

### D-048 Self profile, quiet hours, delay changes
- **Decision:** For a self profile, a missed dose notifies only the owner, once. No quiet hours for missed-dose alerts in v1. A changed delay applies to future doses only.
- **Status:** Accepted · delay-change rule set by D-086

## Transfer and upgrade

### D-049 Transfer
- **Decision:** The owner generates a transfer code; the receiving caregiver must have free quota. Medicines, full dose history, pairing and the patient's devices move intact. The old caregiver loses access. Both sides are audited.
- **Status:** Accepted

### D-050 Patient becomes caregiver
- **Decision:** Subscribing inside the app creates a separate caregiver account on the same phone. Their own patient profile stays with its current owner; to self-manage, the owner transfers it to them and it becomes their self profile. Their caregiver account follows the one-login rule.
- **Status:** Accepted

## Subscriptions and billing

### D-051 RevenueCat
- **Decision:** RevenueCat over Google Play and App Store. Webhooks idempotent by event ID; entitlements verified server-side; a daily reconciliation job catches missed webhooks.
- **Reason:** Confirmed: RevenueCat delivers at least once, reuses event `id` on retries, and recommends re-fetching customer state ([R-21]).
- **Status:** Accepted

### D-052 Plans
- **Decision:** **Starter plan = 3 managed patients.** Other plan names, prices and any free trial are undecided.
- **Status:** Accepted (other plans, prices, trial: OI-01, open)

### D-053 Server-only quota
- **Decision:** Quota is enforced only on the server, at create patient, accept transfer and re-activate, inside a transaction that locks the caregiver's subscription row.
- **Status:** Accepted

### D-054 No subscription = no use; grace
- **Decision:** Enable the stores' own billing grace periods first. After the store reports the subscription expired, the account gets **1 day of grace**: warn the caregiver at expiry and 6 hours before cutoff; patient devices show "Reminders stop tomorrow, ask your caregiver".
- **Status:** Accepted · grace trigger set by D-087

### D-055 Cutoff
- **Decision:** At cutoff, all the caregiver's patients and their self profile become suspended. The server tells every patient device to cancel its scheduled local alarms and show "Reminders paused".
- **Status:** Accepted · amended by D-087

### D-056 Suspended data
- **Decision:** Suspended data is kept indefinitely and read-only: past history viewable; no reminders, alerts, edits or settings changes. Renewing restores everything and re-syncs alarms within a minute. Deletion on request still applies under the DPDP Act.
- **Status:** Accepted ⚠ C-10 (open, legal review)

## Stack

### D-057 Mobile stack
- **Decision:** Expo dev build, `expo-notifications`, `expo-secure-store`, a current background-task module, local SQLite for the offline queue.
- **Checked:** background-task module is `expo-background-task` ([R-03]); SQLite is `expo-sqlite` ([R-05]).
- **Status:** Accepted

### D-058 API stack
- **Decision:** NestJS, REST under `/v1`, JWT for caregivers (sign-in with email OTP, Google, Apple), device tokens for patients. Every write accepts an `Idempotency-Key`.
- **Status:** Accepted · amended by D-083, D-095 (sign-in methods)

### D-059 Data stack
- **Decision:** PostgreSQL + Drizzle ORM. Redis + BullMQ for repeatable jobs only.
- **Status:** Accepted · amended by D-071, D-089

### D-060 Files and billing providers
- **Decision:** Files on Cloudflare R2. Billing via RevenueCat.
- **Status:** Accepted

### D-061 Push
- **Decision:** Expo Push Service over FCM/APNs, with receipts processed (`DeviceNotRegistered` drops the token and flags the device).
- **Status:** Accepted

### D-062 Releases
- **Decision:** EAS Build and EAS Update with separate channels, staged rollout, and a minimum-version check (`GET /app/config`, served as `GET /v1/app/config`) that can force an update.
- **Status:** Accepted · amended by D-080

### D-063 Observability
- **Decision:** Sentry in app and API with medicine names, notes and photos scrubbed; dashboards for sweeper lag, push receipts and device health.
- **Status:** Accepted

### D-064 Data model
- **Decision:** Tables `users`, `caregiver_settings`, `patients`, `devices`, `pairing_codes`, `medicines`, `schedule_versions`, `schedule_times`, `dose_instances`, `notification_log`, `subscriptions`, `audit_log`, with the columns listed in [03-data-model](03-data-model.md).
- **Status:** Accepted · amended by D-082

### D-065 API surface
- **Decision:** Auth, patients, pairing, devices, medicines, upload presign, device sync with cursor, batch dose responses, history and adherence, transfer, settings, subscription and RevenueCat webhook, app config. Detailed in [04-api](04-api.md).
- **Status:** Accepted · amended by D-080, D-081, D-083

## Security and privacy

### D-066 Security baseline
- **Decision:** TLS everywhere; encrypted DB and bucket at rest; field-level encryption for medicine names and notes; Postgres point-in-time recovery with a tested restore; ownership/device scoping on every query with automated isolation tests; audit log (pairing, revoke, transfer, edits, photo access) visible to the caregiver.
- **Status:** Accepted

### D-067 DPDP and store compliance
- **Decision:** Explicit consent at signup and pairing, purpose limitation, export and deletion on request, named grievance contact; store privacy policies, Play exact-alarm declaration, Apple time-sensitive / Critical Alerts justification.
- **Status:** Accepted ⚠ C-10 (open) · amended by D-073, D-081, D-088

## Build phases, SLOs, later

### D-068 Phases and gates
- **Decision:** Phase 0 reminder spike (1 week) → 1 Foundations → 2 Medicines and doses → 3 Reminders → 4 Alerts and billing → 5 Hardening and launch, each with an exit gate, as in [13-roadmap](13-roadmap.md). Test device matrix: one Samsung, one Xiaomi or Oppo, one stock Android, one iPhone — each locked, idle overnight and with battery saver on.
- **Status:** Accepted · amended by D-097 (no Phase 0; simpler device testing)

### D-069 Proposed SLOs
- **Decision:** Missed-dose alert within 2 min of due time for 99.9% of doses · sweeper lag p99 under 60 s · 98% of active patient devices healthy (permissions on, heartbeat under 6 h, window ≥ 2 days) · 99% of offline answers reach the server within 5 min of the network returning · crash-free sessions 99.5%.
- **Status:** Accepted (proposed targets)

### D-070 Later (v1.1)
- **Decision:** Pill stock count with low-stock alert to the caregiver · evening adherence summary · read-aloud of medicine name · more languages.
- **Status:** Deferred (v1.1) · list extended by D-095

## Resolutions (2026-10-28)

The owner accepted the recommended fixes for the conflicts and open items found while documenting. Each entry amends the decisions it names; the original text above stays as history.

- **Date** for D-071 to D-094: 2026-10-28.

### D-071 BullMQ Job Schedulers replace repeatable jobs
- **Decision:** "Repeatable jobs" in D-033, D-037 and D-059 means BullMQ **Job Schedulers** (`upsertJobScheduler`), upserted idempotently on every worker boot.
- **Reason:** BullMQ 6 removed the repeat API ([R-15], [R-16]). The sweeper selects by time, so a late or skipped tick catches up with no behaviour change.
- **Resolves:** C-01 · **Status:** Accepted

### D-072 Alarm type uses alarm-clock delivery
- **Decision:** Alarm-type doses and their 5-minute follow-ups are scheduled with `delivery: 'alarmClock'` (Android `setAlarmClock`). Phase 0 checks whether Standard and Gentle also need it when several doses fall within 9 minutes.
- **Reason:** In Doze, `setExactAndAllowWhileIdle` fires at most once per 9 minutes per app; `setAlarmClock` still fires ([R-29], [R-02]).
- **Resolves:** C-02 · **Status:** Accepted · amended by D-097 (checked in Phase 3, not Phase 0)

### D-073 SCHEDULE_EXACT_ALARM only
- **Decision:** Android uses `SCHEDULE_EXACT_ALARM` only. `USE_EXACT_ALARM` must never appear in the merged manifest (CI check). The "Play exact-alarm declaration" in D-067 becomes an exact-alarm justification in the Play listing and review notes. The full window is re-scheduled on the next app open or background run after the permission changes. "Exact alarm off" is a required permission for conditional push and device problem alerts.
- **Reason:** Play allows `USE_EXACT_ALARM` only for alarm/timer and calendar apps. `SCHEDULE_EXACT_ALARM` is denied by default on Android 14+, and revoking it cancels all future exact alarms ([R-27], [R-28], [R-33]).
- **Resolves:** C-03 · **Status:** Accepted

### D-074 Battery optimisation via the settings list
- **Decision:** Guided setup opens the system battery-optimisation list (`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`) with on-screen guidance. The app does not declare `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` or use the direct-request dialog. OEM-specific guidance screens (Samsung, Xiaomi, Oppo) ship in Phase 5.
- **Reason:** Play restricts the direct request to listed use cases, and medication reminders aren't listed ([R-29]).
- **Resolves:** C-04 · **Status:** Accepted

### D-075 Data pushes are best effort
- **Decision:** Android high-priority data pushes (refill `sync`, `dose_cleared`, `cancel_all`) are kept but treated as best effort, like iOS silent push. Reliability rests on local alarms, visible pushes and app open. Data-push effectiveness is measured on the device-health dashboard.
- **Reason:** FCM deprioritises high-priority messages that don't produce a visible notification ([R-32]).
- **Resolves:** C-05 · **Status:** Accepted

### D-076 iOS lock-screen answers proven in Phase 0
- **Decision:** Phase 0 must prove that Taken / Not taken tapped on a locked iPhone, with the app swiped away, is persisted. If expo-notifications can't do it, the fallback is a small native module (Expo Modules API) that writes the answer to the local queue natively and sends it on the next run. Opening the app on tap is the last resort.
- **Reason:** iOS launches the app in the background for action taps ([R-40]), but expo-notifications documents its background task for action taps as Android-only ([R-02]).
- **Resolves:** C-06 · **Status:** Accepted · amended by D-097 (checked in Phase 3, needs an iPhone, OI-29)

### D-077 Generic text in remote pushes; app works without notifications
- **Decision:**
  - Remote pushes (conditional backup, missed alerts, Not taken alerts, corrections, device alerts) carry generic text plus IDs. Example: "A dose for [patient] at 08:00 has no answer recorded". The app shows medicine details from its own data when opened.
  - Local notifications keep full detail per D-028.
  - Every guided-setup permission can be skipped (skips are reported, D-042). The Today screen and all answers work with notifications off.
- **Reason:** Apple 4.5.4: push must not be required for the app to function and should not carry sensitive personal information ([R-42]).
- **Resolves:** C-07 · **Status:** Accepted

### D-078 One notification budget per phone
- **Decision:**
  - The phone allocates one notification budget across every profile on the device (self and paired patient), earliest notification first.
  - On iOS, when the window can't fit, Alarm follow-ups are scheduled only for the next 24 hours and plain dose notifications beyond that. `scheduled_through` is reported honestly, so conditional push covers the rest.
  - In the window formula (D-038), "repeat" = 0 slots per dose at scheduling time. Snooze re-notifications use the 4 reserve slots.
- **Reason:** The 64-request limit is per app ([R-39]). More than 30 slots/day can't meet the 2-day minimum.
- **Resolves:** C-08, OI-02 · **Status:** Accepted

### D-079 No photo in Android notifications
- **Decision:** iOS shows the cached medicine photo as a notification attachment (when lock-screen detail is `full`). Android notifications show name, amount and time; the photo appears on the Today screen.
- **Reason:** expo-notifications supports local `attachments` on iOS only ([R-02]).
- **Resolves:** C-09 · **Status:** Accepted

### D-080 App config path and forced update in patient mode
- **Decision:**
  - The minimum-version endpoint is `GET /v1/app/config`, and its contract never breaks.
  - In patient mode, the "Update required" screen blocks sync and edits but never cancels alarms already scheduled.
  - The API keeps accepting `devices/heartbeat` and `device/dose-responses` from versions below the minimum.
- **Reason:** All routes are under `/v1` (D-058); reminders are the product.
- **Resolves:** C-11, OI-27 · **Status:** Accepted

### D-081 In-app account deletion
- **Decision:** Caregiver Settings has *Delete account* (`POST /v1/me/delete`), in addition to requests through the grievance contact. Retention follows C-10.
- **Reason:** Apple 5.1.1(v) requires account deletion within the app ([R-42]).
- **Resolves:** C-12 · **Status:** Accepted

### D-082 Schema additions
- **Decision:** Add to the D-064 schema:
  - **Columns:**
    - `patients.display_name` (encrypted), `patients.lockscreen_detail` (per-patient override)
    - `medicines.photo_object_key`
    - `dose_instances.alert_due_at`
    - `notification_log.patient_id`, `device_id`, `group_key`, `status`
    - `devices.push_invalid_at`, `devices.label`
    - `pairing_codes.lookup_hash`, `invalidated_at`
    - `subscriptions.expired_at`, `cutoff_at`
  - **Tables:** `auth_sessions`, `otp_challenges` (v1.1, per D-095), `idempotency_keys`, `rc_webhook_events`, `consents`.
  - **`notification_kind` gains:** `not_taken`, `window_low`, `billing`, `pairing`, `sync`.
  - `caregiver_settings.daily_summary` stays in the schema, unused until v1.1.
- **Reason:** Needed to implement agreed behaviour: one login, OTP, idempotency, webhook dedupe, DPDP consent records, the frozen missed deadline, and alert kinds.
- **Resolves:** OI-03, OI-04, OI-20 · **Status:** Accepted

### D-083 Sign-out endpoint and idempotency retention
- **Decision:** Add `POST /v1/auth/logout`. `Idempotency-Key` records are kept for 24 hours, scoped per principal (user or device).
- **Resolves:** OI-08, OI-11 · **Status:** Accepted

### D-084 Pairing limits, device limit and code lookup
- **Decision:**
  - **Rate limits on `pairing/redeem`:** 10 attempts per minute per IP; 5 per device install per 10 minutes. A global failure rate above 5× the 7-day baseline pages the owner.
  - **Device limit:** a 4th active patient device is refused with `409 DEVICE_LIMIT_REACHED`; the caregiver revokes one first.
  - **Code lookup:** the first 4 symbols of a code act as a lookup ID (`lookup_hash`), and the full 8 symbols are verified against `code_hash`. A wrong full code against a live lookup ID counts as a failed attempt on that code (5 → locked).
- **Resolves:** OI-12, OI-14, OI-25 · **Status:** Accepted

### D-085 Answer merge and snooze cut-off
- **Decision:**
  - **Earliest answer wins:** compare `responded_at` clamped to `[scheduled_at − 1 h, received_at]`; ties are broken by `received_at`.
  - **Snooze cut-off:** Snooze is hidden (and refused by the server) when `now + 10 min ≥ alert_due_at`.
- **Resolves:** OI-05, OI-15 · **Status:** Accepted

### D-086 DST, timezone source and delay changes
- **Decision:**
  - **DST gap:** a local time inside a spring-forward gap fires at the first valid minute after the gap.
  - **DST overlap:** an ambiguous fall-back time fires at its first occurrence.
  - **Timezone source:** with `follow_device`, the patient timezone comes from the most recently seen active device. The caregiver is told when the patient's devices disagree.
  - **Delay changes:** "a changed delay applies to future doses only" (D-048) means doses *scheduled* after the change. On a delay change, `alert_due_at` is recomputed for pending doses with `scheduled_at > now()`.
- **Resolves:** OI-21, OI-22, OI-26 · **Status:** Accepted

### D-087 Grace trigger and grace-capped windows
- **Decision:**
  - **Trigger:** the 1-day grace starts when RevenueCat reports no active entitlement (`gives_access = false`), including Google Play account hold.
  - **Capped windows:** during grace, the server issues dose windows that end at `cutoff_at`, so phones that sync during grace hold no alarms past cutoff.
- **Reason:** Account hold removes entitlement before formal expiry ([R-25]). iOS can't be relied on to receive the cancel command (D-039).
- **Resolves:** OI-06, OI-23 · **Status:** Accepted

### D-088 Store declarations
- **Decision:** Phase 5 completes:
  - the Play **Health apps declaration** (category *Medication and Treatment Management*);
  - the Play Data safety form;
  - App Store privacy details.
- **Reason:** Required by the stores ([R-34], [R-42]).
- **Resolves:** OI-09 · **Status:** Accepted

### D-089 Drizzle 0.45.x
- **Decision:** Start on the stable `drizzle-orm` 0.45.x line. Plan the 1.0 upgrade once it's stable.
- **Resolves:** OI-07 · **Status:** Accepted

### D-090 Expo Push access token
- **Decision:** Enable Expo Push "enhanced security", so only our server (holding the access token) can send pushes to our users.
- **Resolves:** OI-10 · **Status:** Accepted

### D-091 Photo size cap
- **Decision:** Photos are at most **1 MB** after compression, longest edge **1280 px**. The server verifies size and type with `HEAD` before attaching the photo to a medicine, and deletes oversize objects.
- **Reason:** R2 presigned PUT gives no documented way to enforce length ([R-19]).
- **Resolves:** OI-13 · **Status:** Accepted

### D-092 One self profile per caregiver
- **Decision:** A caregiver has at most one self profile.
- **Resolves:** OI-16 · **Status:** Accepted

### D-093 Window-low push throttle
- **Decision:** The patient-side visible push "Open the app to keep reminders on schedule" is sent at most once per 12 hours per device, the same throttle as D-047.
- **Resolves:** OI-17 · **Status:** Accepted

### D-094 Alarm and Gentle sounds
- **Decision:**
  - **Alarm:** custom long sound, high importance, vibration (Android); `timeSensitive` with a custom sound (iOS).
  - **Gentle:** default importance, no sound override (Android); `active` level (iOS).
- **Resolves:** OI-24 · **Status:** Accepted

## Owner changes

### D-095 Caregiver sign-in is email + password in v1
- **Date:** 2026-10-28
- **Decision:**
  - **v1 sign-in:** caregivers register and sign in with **email + password**. No email verification.
  - **Moved to v1.1:** email OTP, Google sign-in, Apple sign-in and all email verification. This amends the sign-in list in D-058; D-070 gains these items.
  - **Password storage:** Argon2id with at least the OWASP minimum parameters (m = 19 MiB, t = 2, p = 1) plus a pepper from the secret manager ([R-47]).
  - **Password rules:** length 15–128 characters, with no composition rules and no silent truncation ([R-48]).
  - **Errors:** sign-in failures return one generic error with the same status and timing whether the email exists or not.
  - **Throttling:** failed sign-ins are throttled per account (progressive delay) and per IP. There is no hard lockout, because v1 has no recovery flow to unlock an account.
  - **Re-authentication:** the current password is required to delete the account.
  - Everything else is unchanged: one active login (D-019), consent at signup (D-067), RevenueCat `app_user_id` = `users.id`.
- **Reason:** Simpler v1. Apple 4.8 applies only when third-party or social login is offered, so with email + password alone, Sign in with Apple isn't required until Google sign-in ships in v1.1 ([R-42]).
- **Accepted risks:**
  - A mistyped email can't be corrected or used for recovery.
  - Anyone can register with someone else's address.
  - Registration reveals whether an email is already taken.
- **Status:** Accepted · amended by D-096 (password length, no reset)

### D-096 8-character password minimum; no password reset in v1
- **Date:** 2026-10-28
- **Decision:**
  - **Length:** caregiver passwords are **8–128 characters** (replaces 15–128 in D-095). Still no composition rules and no silent truncation.
  - **No reset or recovery in v1:** no password reset or account recovery flow, and no in-app password change. A caregiver who forgets their password can't sign in again.
  - **No breach check:** new passwords aren't checked against breached-password lists in v1.
- **Reason:** Owner choice for a simpler v1. This is shorter than OWASP's 15-character guidance for accounts without MFA ([R-48]). Argon2id, generic errors and per-account throttling stay as the compensating controls.
- **Accepted risks:**
  - weaker passwords are easier to guess;
  - a forgotten password permanently locks the caregiver out of that account (alarms and alerts already on their signed-in phone keep working until they're signed out).
- **Resolves:** OI-28 · **Status:** Accepted

### D-097 No Phase 0 spike; fewer tests; reliability checked in Phase 3
- **Date:** 2026-10-30
- **Decision:**
  - **No Phase 0.** The reminder spike and its app (`spike/`) are dropped. Work starts at Phase 1. This amends D-068: phases are 1–5.
  - **Reliability is checked on the real app in Phase 3** instead, on whatever Android phone(s) the owner has, with the app killed: lock-screen answers, Alarm follow-ups in Doze, exact-alarm revoke and grant, battery-settings flow. The checks are listed under Phase 3 in [13-roadmap](13-roadmap.md). The `USE_EXACT_ALARM` manifest check stays a CI check (D-073).
  - **Device testing:** the 4-phone × 3-state matrix is dropped. Phase 3 needs one real Android phone, locked and killed, once overnight. Phase 5 adds OEM checks on the beta group's own phones.
  - **Test layers dropped:** mobile E2E (Maestro/Detox), the OpenAPI contract-test layer, and the chaos-case table. Their useful cases are already unit or integration tests (sweeper restart, webhook dedupe, outbox retry, answer clamping, grace cutoff); Redis loss is added as one integration test.
  - **Test layers kept:** everything CLAUDE.md names as non-negotiable (isolation matrix, `Idempotency-Key`, no PII in Sentry events) plus the dose-generation property tests and the reminder-engine tests in [12](12-testing-and-slos.md).
- **Reason:** Owner choice: spike and device-matrix steps were blocking real development. Each check now happens inside the phase that builds the feature, so it costs no separate step.
- **Accepted risks:**
  - A Doze, OEM or Android killed-app problem is found later (Phase 3), after more code exists. The scheduler code is kept thin and behind one module so it can change.
  - D-072's open question (do Standard and Gentle also need `alarmClock`?) is answered in Phase 3.
  - The iOS items stay unverified (OI-29).
- **Status:** Accepted

## Conflicts found while documenting

Found on 2026-10-28 by checking current official docs. Kept as history; each points to the decision that resolved it.

### C-01 BullMQ 6 removed "repeatable jobs" — resolved (D-071)
- **Affects:** D-033, D-037, D-059.
- **Finding:** BullMQ's repeat API was deprecated in 5.16.0 and removed in v6 (current: 6.5.0). The replacement is Job Schedulers; a scheduler produces its next job only when the previous one starts processing ([R-15], [R-16]).

### C-02 Android Doze limits Alarm follow-ups every 5 minutes — resolved (D-072)
- **Affects:** D-025.
- **Finding:** In Doze, `setExactAndAllowWhileIdle()` fires at most once per 9 minutes per app; `setAlarmClock()` still fires ([R-29]). expo-notifications exposes it as `delivery: 'alarmClock'`, which needs the exact-alarm permission ([R-02]).

### C-03 Exact-alarm permission and the "Play exact-alarm declaration" — resolved (D-073)
- **Affects:** D-042, D-067.
- **Finding:**
  - Play allows `USE_EXACT_ALARM` (the permission with a Play Console declaration) only for alarm/timer or calendar apps ([R-33]).
  - `SCHEDULE_EXACT_ALARM` is denied by default for new installs on Android 14+, and revoking it cancels all future exact alarms ([R-27], [R-28]).

### C-04 Battery-optimisation exemption request is Play-restricted — resolved (D-074)
- **Affects:** D-042.
- **Finding:** Play prohibits the direct Doze exemption request unless the core function is affected. The acceptable-use list doesn't name medication reminders ([R-29]).

### C-05 FCM deprioritises high-priority data-only pushes — resolved (D-075)
- **Affects:** D-018, D-039.
- **Finding:** High-priority FCM messages that don't produce user-visible notifications may be downgraded (judged per app instance over 7 days). Firebase recommends `AndroidConfigV2` `BackgroundSync` for non-urgent updates ([R-32]).

### C-06 iOS lock-screen answers while the app is terminated — resolved (D-076)
- **Affects:** D-029, Phase 3 gate (was Phase 0, D-097).
- **Finding:** iOS launches the app in the background for action taps ([R-40]). expo-notifications documents its background task for action taps "only on Android" ([R-02]).

### C-07 Apple 4.5.4 — push must not be required and must not carry sensitive data — resolved (D-077)
- **Affects:** D-002, D-028, D-042, D-044.
- **Finding:** "Push Notifications must not be required for the app to function, and should not be used to send sensitive personal or confidential information" ([R-42]).

### C-08 iOS 64-slot budget vs "minimum 2 days" and dual-role phones — resolved (D-078)
- **Affects:** D-009, D-038.
- **Finding:** The limit is 64 pending requests per app ([R-39]). Above 30 slots per day the 2-day minimum can't fit (e.g. 6 Alarm doses at a 30-minute delay = 36 slots). Profiles on one phone share the budget.

### C-09 Photo in lock-screen notifications on Android — resolved (D-079)
- **Affects:** D-028.
- **Finding:** expo-notifications supports local `attachments` on iOS only ([R-02]).

### C-10 DPDP Act and Rules — **owner + legal counsel: review before Phase 5**
- **Status:** **Open.** Needs legal counsel; not resolved by the 2026-10-28 resolutions.
- **Affects:** D-056, D-067.
- **Findings:**
  - (a) s.8(7) requires erasure when consent is withdrawn or the specified purpose is no longer served. Indefinite retention of suspended data needs a stated purpose and legal review ([R-43]).
  - (b) Rule 8(3) requires keeping personal data, traffic data and processing logs for at least **one year** from processing, even after account deletion. Deletion must therefore keep audit and processing logs for one year ([R-44]).
  - (c) If the patient is a child (under 18) or a person with disability who has a lawful guardian, s.9 and Rules 10–11 require verifiable consent of the parent or guardian, with due diligence. s.9(3) prohibits "tracking or behavioural monitoring of children". Adherence monitoring of a child patient may fall under it.
  - (d) The caregiver enters the patient's data before the patient consents at pairing.
  - Most Rules (3, 5–16, 22, 23) apply from **13 May 2027**. Breach intimation (Rule 7): the Board within 72 hours. Grievance response: within 90 days (Rule 14).
- **Recommended fix:** Legal review of (a)–(d). Possible measures: ask at patient creation whether the patient is under 18 or has a lawful guardian; record the caregiver's declaration and the patient's consent at pairing; define a retention period for suspended data. Until then, logs are kept ≥ 1 year (needed under any outcome).

### C-11 GET /app/config path — resolved (D-080)
- **Affects:** D-062.
- **Finding:** Every other route is under `/v1` (D-058).

### C-12 Apple 5.1.1(v) requires in-app account deletion — resolved (D-081)
- **Affects:** D-067.
- **Finding:** "If your app supports account creation, you must also offer account deletion within the app" ([R-42]).

## Open items

| ID | Item | Notes |
| --- | --- | --- |
| OI-01 | Plan names, prices, and whether new caregivers get a free trial | Undecided. Only Starter = 3 is fixed. Needed before Phase 4 |
| OI-18 | Retention of archived and suspended patients, medicines and history | Depends on C-10 legal review |
| OI-29 | No iPhone available (owner, 2026-10-30) | Phase 0 no longer exists (D-097) and the iOS checks were never run, so D-027 (time-sensitive, Focus), D-076 (iOS lock-screen answers with the app killed), D-078 (64-request limit on current iOS) and D-079 (photo attachment) are unverified. Must be run on a real iPhone, or iOS dropped from v1 by a new decision, before Phase 3 ends and before any iOS release. The iPhone half of the Phase 3 gate can't pass until then |
| OI-30 | Idempotency on writes with no caller, or with secrets in the response | Found while building the interceptor (2026-10-30). Doc 04 requires `Idempotency-Key` on all writes except `auth/*` and the webhook, but (a) `pairing/redeem` and `pairing/challenge` have no authenticated caller, so there is no principal to scope a key to, and (b) `pairing/redeem` and transfer redeem return a device token, which the idempotency table would store. **Recommended fix:** exempt `pairing/challenge`, `pairing/redeem` and `transfer/redeem` like `auth/*`. Redeem is single-use by design (a retry gets `CODE_EXPIRED_OR_USED`), and a lost response is recovered by generating a new code. Until you decide, the interceptor fails closed (500) on any write without a caller, so nothing slips through unprotected |
| OI-19 | Named grievance contact and Data Protection contact | Needs a person and an address before store submission (Phase 5) |

### Resolved open items

| ID | Resolved by |
| --- | --- |
| OI-02 "repeat" slot | D-078 |
| OI-03 notification kinds | D-082 |
| OI-04 schema additions | D-082 |
| OI-05 answer merge rule | D-085 |
| OI-06 grace trigger | D-087 |
| OI-07 Drizzle version | D-089 |
| OI-08 sign-out endpoint | D-083 |
| OI-09 store declarations | D-088 |
| OI-10 Expo Push access token | D-090 |
| OI-11 idempotency retention | D-083 |
| OI-12 pairing rate limits | D-084 |
| OI-13 photo size cap | D-091 |
| OI-14 4th device | D-084 |
| OI-15 snooze cut-off | D-085 |
| OI-16 one self profile | D-092 |
| OI-17 window-low push throttle | D-093 |
| OI-20 `daily_summary` column | D-082 |
| OI-21 DST rule | D-086 |
| OI-22 timezone source | D-086 |
| OI-23 grace-capped windows | D-087 |
| OI-24 Alarm/Gentle sounds | D-094 |
| OI-25 code lookup | D-084 |
| OI-26 delay-change meaning | D-086 |
| OI-27 forced update in patient mode | D-080 |
| OI-28 password recovery / change | D-096 (none in v1) |

[R-02]: references.md
[R-15]: references.md
[R-16]: references.md
[R-19]: references.md
[R-25]: references.md
[R-27]: references.md
[R-28]: references.md
[R-29]: references.md
[R-32]: references.md
[R-33]: references.md
[R-34]: references.md
[R-39]: references.md
[R-40]: references.md
[R-42]: references.md
[R-43]: references.md
[R-44]: references.md
[R-03]: references.md
[R-05]: references.md
[R-06]: references.md
[R-07]: references.md
[R-21]: references.md
[R-30]: references.md
[R-35]: references.md
[R-38]: references.md
[R-41]: references.md
[R-47]: references.md
[R-48]: references.md
