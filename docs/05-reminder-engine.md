# Reminder engine

Reminder reliability is the product. This doc covers how a schedule becomes notifications on the patient's phone, and what the server does when the phone can't be trusted. Missed-dose alerts to the caregiver are in [09](09-missed-dose-alerts.md). Platform notification details are in [08](08-notifications-and-platform.md).

## Principles

1. **Postgres is the source of truth** for every dose and alert. Redis only triggers jobs; losing Redis loses no reminder ([D-033](01-decisions.md#d-033-postgres-is-the-source-of-truth)).
2. **The phone never computes doses.** It schedules local notifications only from server-issued `dose_instances`, using the dose ID as the notification identifier ([D-035](01-decisions.md#d-035-phone-never-computes-doses)).
3. **Local first, push as backup.** The local alarm is the primary reminder. The server pushes only when it has reason to believe the local alarm won't fire ([D-036](01-decisions.md#d-036-conditional-push-backup)).
4. **Everything is idempotent.** Jobs select by time and mark rows in the same transaction, so restarts, retries and duplicate workers are safe.

## End-to-end sequence

```mermaid
sequenceDiagram
  autonumber
  participant CG as Caregiver app
  participant API as API
  participant PG as Postgres
  participant W as Worker (Job Schedulers)
  participant PH as Patient phone
  participant EX as Expo Push → FCM/APNs

  CG->>API: POST /v1/patients/{id}/medicines
  API->>PG: insert medicine, schedule_version, schedule_times
  API->>PG: generate dose_instances (now → +14 d)
  API-->>EX: data push "sync" (best effort, D-075)
  PH->>API: GET /v1/device/sync (app open / background task / push)
  API->>PG: read window for this device
  API-->>PH: doses in window + medicines + photo URLs
  PH->>PH: reconcile local notifications (id = dose id)
  PH->>API: POST /v1/devices/heartbeat {scheduled_through, permissions, tz}
  Note over W: every 60 s
  W->>PG: BEGIN; select due doses FOR UPDATE SKIP LOCKED
  alt device needs backup (beyond scheduled_through, stale > 12 h, or permission off)
    W->>PG: insert notification_log(kind=backup), set push_sent_at
    W->>EX: visible push with Taken / Not taken / Snooze actions
  else healthy device
    W->>PG: set push_sent_at (no push)
  end
  W->>PG: COMMIT
  PH->>PH: local notification fires at scheduled time
  PH->>PH: patient taps Taken → write outbox (SQLite)
  PH->>API: POST /v1/device/dose-responses [client_event_id…]
  API->>PG: apply earliest answer; status=taken
  API-->>EX: data push "dose cleared" to other patient devices
  Note over W: at alert_due_at with no answer → 09-missed-dose-alerts
```

## Dose generation

**Job:** `dose-generator` Job Scheduler, daily. It also runs on demand (as a queued job, idempotent per patient) after: medicine create/edit/archive, patient timezone change, reactivation, renewal, transfer.

**Window:** from now to **14 days** ahead, in the patient's effective timezone ([D-034](01-decisions.md#d-034-dose-generation)).

For each `active` patient (never `suspended` or `archived`), each non-archived medicine, and each schedule version overlapping the window:

1. For each local date `d` in the window, within `[start_date, end_date]` and the version's `[effective_from, effective_until)`:
   - `daily`: every date.
   - `weekdays`: `isoDayOfWeek(d) ∈ days_of_week`.
   - `every_n_days`: `(d − start_date) mod interval_days = 0`. The anchor is the version's `start_date`; an edit copies `start_date` forward unless the caregiver changes it, so editing doesn't shift the cycle.
2. For each `schedule_times` row: local wall-clock `d + local_time` in the patient timezone → UTC `scheduled_at`.
   - **DST never moves the local clock time:** 08:00 stays 08:00 across DST changes. A local time inside a spring-forward gap fires at the first valid minute after the gap; an ambiguous fall-back time fires at its first occurrence ([D-086](01-decisions.md#d-086-dst-timezone-source-and-delay-changes).
3. Skip instants earlier than `effective_from` (so an edit at 10:00 doesn't recreate today's 08:00 dose).
4. Snapshot `name_snapshot` (encrypted) and `amount_snapshot`. Compute `alert_due_at = scheduled_at + resolved delay` ([09](09-missed-dose-alerts.md#delay-resolution)).
5. `INSERT … ON CONFLICT (medicine_id, scheduled_at) DO NOTHING`.

**No end date** means the medicine runs as long as the subscription is active ([D-022](01-decisions.md#d-022-start-and-end-dates)). Generation stops when the patient is suspended and resumes on renewal.

Implementation: `apps/api/src/doses/schedule.ts` (pure expansion, tested with property tests over random schedules, six time zones and DST windows) and `doses.service.ts` (writes rows in the caller's transaction). It uses the built-in `Temporal` (Node 26, [R-69](references.md)). Temporal's default for a time inside a gap shifts it by the gap length (02:30 → 03:30); D-086 wants the first valid minute after the gap (→ 03:00), so the gap's end is taken from the latest zone transition at or before the shifted instant. Two times that collapse onto one instant at a gap give one dose.

### Edits regenerate only future pending doses
Inside one transaction, on `PATCH /v1/medicines/{id}`, timezone change or archive:
1. Set `effective_until = now()` on the current version and insert the new version with `effective_from = now()` (medicine edits only).
2. `DELETE FROM dose_instances WHERE medicine_id = $1 AND scheduled_at > now() AND status = 'pending'`. Answered, snoozed, missed and past doses are never touched.
3. Generate from the new version (or new timezone) as above.
4. Enqueue a sync data push for the patient's devices. On the next sync, phones cancel notifications whose dose IDs disappeared.

## Device scheduling

On every sync the phone:
1. Stores the issued doses and medicines in SQLite and downloads changed photos to the cache.
2. Builds the desired notification set from **all profiles on this phone** (a paired patient profile and/or a self profile, [D-009](01-decisions.md#d-009-dual-roles-on-one-phone)):
   - One notification per dose, identifier `dose:{doseId}`.
   - Alarm type: follow-ups every 5 minutes, `dose:{doseId}:f{n}`, until `alert_due_at` (exclusive).
   - A snoozed dose: `dose:{doseId}:s` at `snooze_until`.
3. Applies the budget ([Window size](#window-size)), earliest first.
4. Reconciles: cancels scheduled notifications not in the desired set and schedules missing ones. Identical identifiers replace, never duplicate.
5. Records `scheduled_through` = the `scheduled_at` of the last dose whose main notification **and** all its follow-ups are scheduled. It reports this in the next heartbeat.

Doses already answered locally (in the outbox) are never re-scheduled, even if the server still says `pending`.

## Window size

| Platform | Rule |
| --- | --- |
| iOS | At most 64 pending local notification requests per app ([R-39](references.md); Apple staff, Jan 2026 — re-verify each iOS release). **Window days = 60 ÷ notification slots per day**, minimum 2 days. 4 slots are reserved (snoozes, ad-hoc). |
| Android | 5 days. |

Slots per day for a dose = 1 (dose) + Alarm follow-ups. "Repeat" slots are 0 at scheduling time; snooze re-notifications use the 4 reserve slots ([D-078](01-decisions.md#d-078-one-notification-budget-per-phone)). Alarm follow-ups per dose = ⌈delay ÷ 5⌉ − 1. Example: a 30-min delay gives follow-ups at +5, +10, +15, +20, +25 = 5, so 6 slots.

| Example (iOS) | Slots/day | Window |
| --- | --- | --- |
| 3 Standard doses | 3 | 20 days → capped at 14 (generation horizon) |
| 2 Alarm doses, 30-min delay | 12 | 5 days |
| 4 Alarm doses, 30-min delay | 24 | 2 days (60 ÷ 24 = 2.5) |
| 6 Alarm doses, 30-min delay | 36 | 2 days don't fit (72 > 60): follow-ups for the next 24 h only, plain doses after ([D-078](01-decisions.md#d-078-one-notification-budget-per-phone)) |

The server issues doses for `max(window, 2 days)`, capped at 14 days. The phone enforces one budget across all profiles, earliest first. When the window doesn't fit on iOS, Alarm follow-ups are scheduled only for the next 24 hours, and plain dose notifications beyond that. If even that doesn't fit, `scheduled_through` is lower than the issued window, and conditional push covers the gap ([D-078](01-decisions.md#d-078-one-notification-budget-per-phone)).

## Conditional push backup

Evaluated per due dose, per active device of the patient, in the [minute sweeper](#minute-sweeper). A visible backup push is sent to a device only if at least one is true ([D-036](01-decisions.md#d-036-conditional-push-backup)):

| Condition | Source |
| --- | --- |
| `dose.scheduled_at > device.scheduled_through` | last heartbeat |
| `device.last_seen_at < now() − 12 h` | last heartbeat |
| a required permission is off: notifications; on Android exact alarm ([D-073](01-decisions.md#d-073-schedule_exact_alarm-only)); battery unrestricted ([D-074](01-decisions.md#d-074-battery-optimisation-via-the-settings-list)); on iOS time-sensitive | last heartbeat |

Healthy phones never get a duplicate. The backup push uses the same category (Taken / Not taken / Snooze actions), `channelId` by notification type, and iOS `interruptionLevel`. Content is generic text plus IDs ([D-077](01-decisions.md#d-077-generic-text-in-remote-pushes-app-works-without-notifications).

## Minute sweeper

`sweeper` Job Scheduler, `every: 60_000` ms ([D-071](01-decisions.md#d-071-bullmq-job-schedulers-replace-repeatable-jobs): BullMQ 6 Job Scheduler). Each run loops in batches until no rows remain or 50 s pass:

```sql
-- Pass A: backup push evaluation (uses dose_push_due_idx)
BEGIN;
SELECT d.* FROM dose_instances d
JOIN patients p ON p.id = d.patient_id AND p.status = 'active'
WHERE d.push_sent_at IS NULL
  AND d.status IN ('pending','snoozed')
  AND d.scheduled_at <= now()
  AND d.alert_due_at > now()   -- past the deadline, Pass B marks it missed instead
ORDER BY d.scheduled_at
LIMIT 500
FOR UPDATE OF d SKIP LOCKED;
-- for each dose × active device needing backup: INSERT notification_log (kind='backup', status='queued')
UPDATE dose_instances SET push_sent_at = now() WHERE id = ANY($ids);
COMMIT;

-- Pass B: missed alerts (uses dose_alert_due_idx) → see 09-missed-dose-alerts.md
-- Pass C: billing cutoff → see 07-subscriptions-and-billing.md
```

- `FOR UPDATE SKIP LOCKED` lets several workers run safely. Marking in the same transaction makes each row processed exactly once.
- `notification_log` is the **outbox**: rows are committed with `status = 'queued'`, then a sender job posts them to Expo in batches of ≤ 100 ([R-08](references.md)) and records tickets. A crash between commit and send leaves `queued` rows, which the next run sends.
- A late or skipped tick (Redis restart, deploy) catches up, because selection is by time, not by tick.
- **Sweeper lag** = `now() − min(scheduled_at)` of unprocessed due rows. It's exported as a metric ([12](12-testing-and-slos.md#slos)).

## Push delivery and receipts

- Send via `expo-server-sdk` in chunks of ≤ 100, respecting 600 notifications/s per project. Retry `429`/`5xx` with exponential backoff; never retry `400` ([R-08](references.md)).
- `push-receipts` job every 15 min: fetch receipts (≤ 1000 IDs per call) for tickets older than 15 min and younger than 24 h (receipts are deleted after 24 h).
- `DeviceNotRegistered` (ticket or receipt): clear `devices.push_token` and set `push_invalid_at`. The device counts as unhealthy, which triggers a device problem alert ([09](09-missed-dose-alerts.md#device-problem-alerts)). The app re-registers its token on its next heartbeat.
- `MessageRateExceeded`: back off for that device. `InvalidCredentials` / `MismatchSenderId`: page the owner (config error).

## Refill

The window must be topped up before it runs out ([D-039](01-decisions.md#d-039-refill-paths)).

| Path | Platform | Reliability |
| --- | --- | --- |
| App open (foreground) | both | Reliable when the patient opens the app |
| `expo-background-task` | Android: WorkManager, min 15 min, not in Doze. iOS: BGTaskScheduler, system-chosen timing, stops if the user force-quits ([R-03](references.md)) | Opportunistic |
| High-priority data push (`sync`) | Android | Best effort, may be deprioritised ([D-075](01-decisions.md#d-075-data-pushes-are-best-effort)) |
| Silent push (`contentAvailable`) | iOS | Bonus only |
| **Visible push** "Open the app to keep reminders on schedule" | both | Sent when `scheduled_through < now() + 24 h`; the caregiver is warned too (device problem alert) |

The `device-health` job checks windows every 15 min. The visible window-low push is sent at most once per 12 hours per device ([D-093](01-decisions.md#d-093-window-low-push-throttle)).

## Timezone

([D-040](01-decisions.md#d-040-timezone))
- `tz_mode = follow_device`: doses follow the phone's current timezone, reported in the heartbeat. If a heartbeat's `tz` differs from `patients.timezone`, then in one transaction: update `patients.timezone`, regenerate future pending doses, write an audit row, and notify the caregiver ("[Patient]'s reminders now follow [Asia/Dubai]"). The most recently seen active device wins; if the patient's devices report different timezones, the caregiver is told ([D-086](01-decisions.md#d-086-dst-timezone-source-and-delay-changes)).
- `tz_mode = fixed`: the caregiver's pinned timezone; device `tz` is only recorded.
- The phone schedules notifications at absolute UTC instants (date triggers), so a device timezone change never shifts already-scheduled alarms. Only regeneration does.

## Heartbeat

Sent on app open, from the background task, and with every sync ([D-041](01-decisions.md#d-041-heartbeat)): push token, permissions (notifications, exact alarm, battery unrestricted, time-sensitive), app version, timezone, `scheduled_through`. The server updates the `devices` row and `last_seen_at`, and returns `sync_needed` if the window is stale or the cursor is behind.

Caregiver phones send heartbeats too, to keep their push token fresh.

## Answers and sync

([D-029](01-decisions.md#d-029-answer-options)–[D-032](01-decisions.md#d-032-late-answers))
1. A tap (lock-screen action or Today screen) writes an outbox row in SQLite in one local transaction: `{client_event_id (uuid v7), dose_id, action, responded_at}`. It cancels that dose's pending local notifications (main, follow-ups, snooze).
   - iOS lock-screen taps with the app terminated: [D-076](01-decisions.md#d-076-ios-lock-screen-answers-proven-in-phase-0).
2. The outbox is flushed in batches (`POST /v1/device/dose-responses`) on tap, on app open, from the background task and on network regain. Exponential backoff.
3. Server per item, in a transaction locking the dose row:
   - Duplicate `client_event_id` → `duplicate` (no-op).
   - `snooze`: allowed only if the dose is `pending`/`snoozed` and `now + 10 min < alert_due_at`; otherwise refused, and the phone hides Snooze ([D-085](01-decisions.md#d-085-answer-merge-and-snooze-cut-off)). Set `status = 'snoozed'`, `snooze_until = responded_at + 10 min`. Never changes `alert_due_at` ([D-030](01-decisions.md#d-030-snooze-limits)).
   - `taken` / `not_taken`: if the dose has no final answer, or this answer is earlier (`responded_at` clamped to `[scheduled_at − 1 h, received_at]`, ties by `received_at`; [D-085](01-decisions.md#d-085-answer-merge-and-snooze-cut-off)), set `status`, `responded_at`, `received_at = now()`, `client_event_id`. Otherwise → `superseded`.
   - If the dose was `missed` (alert already sent): status flips and a **correction** goes to the caregiver ([09](09-missed-dose-alerts.md#corrections)).
   - `not_taken` → immediate caregiver alert ([D-045](01-decisions.md#d-045-not-taken-alert)).
4. After commit: data push `dose_cleared` to the patient's other active devices ([D-018](01-decisions.md#d-018-up-to-3-patient-devices)). They cancel that dose's notifications. Their next sync also reflects it.

Snooze on the phone: cancel remaining follow-ups, schedule `dose:{id}:s` at `snooze_until`. For Alarm type, follow-ups resume every 5 min after `snooze_until` until `alert_due_at`.

## Suspended and paused state

When a patient is suspended ([07](07-subscriptions-and-billing.md#cutoff)), sync returns `commands: ["cancel_all"]`, an empty window and `account_state: "suspended"`. The phone cancels every notification for that profile and shows "Reminders paused". No generation, backup push or alert runs for suspended patients.
