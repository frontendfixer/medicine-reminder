# Missed-dose alerts

Alerts to the owner caregiver: missed doses, Not taken answers, corrections and device problems. Decisions: [D-043](01-decisions.md#d-043-missed-delay-and-resolution-order)–[D-048](01-decisions.md#d-048-self-profile-quiet-hours-delay-changes), [D-006](01-decisions.md#d-006-only-owner-caregiver-and-patient-are-notified).

Only the caregiver who owns the patient is alerted. A caregiver has one active login ([D-019](01-decisions.md#d-019-one-caregiver-login)), so "every caregiver device" is that one device.

## Delay resolution

| Level | Column | Set in |
| --- | --- | --- |
| 1. Medicine | `medicines.missed_delay_min` | Medicine form |
| 2. Patient | `patients.missed_delay_min` | Patient settings |
| 3. App default | `caregiver_settings.default_missed_delay_min` = **30** | App settings |

`resolved = coalesce(medicine, patient, app default)`. It's evaluated when the dose is generated and stored as `dose_instances.alert_due_at = scheduled_at + resolved` ([D-082](01-decisions.md#d-082-schema-additions)).

**A changed delay applies to future doses only** ([D-048](01-decisions.md#d-048-self-profile-quiet-hours-delay-changes)), where "future" means doses *scheduled* after the change ([D-086](01-decisions.md#d-086-dst-timezone-source-and-delay-changes)). On any delay change (medicine, patient or app default), in one transaction: recompute `alert_due_at` for affected doses with `status IN ('pending','snoozed')` and `scheduled_at > now()`. Doses already due keep their deadline.

## Missed alert

The sweeper's Pass B runs every minute ([05](05-reminder-engine.md#minute-sweeper), [D-044](01-decisions.md#d-044-missed-alert)):

```sql
BEGIN;
SELECT d.* FROM dose_instances d
JOIN patients p ON p.id = d.patient_id AND p.status = 'active'
WHERE d.alert_sent_at IS NULL
  AND d.status IN ('pending','snoozed')
  AND d.alert_due_at <= now()
ORDER BY d.alert_due_at
LIMIT 500
FOR UPDATE OF d SKIP LOCKED;
UPDATE dose_instances SET status = 'missed', alert_sent_at = now() WHERE id = ANY($ids);
-- group by patient (see Grouping), INSERT notification_log(kind='missed', status='queued') per caregiver device
COMMIT;
```

- Snoozing never moves `alert_due_at` ([D-030](01-decisions.md#d-030-snooze-limits)).
- **Text:** "No answer recorded for [medicine, amount] at [time]". It never says "Not taken", because the patient may be offline. That's the in-app text. The push itself carries generic text plus IDs ([D-077](01-decisions.md#d-077-generic-text-in-remote-pushes-app-works-without-notifications)): "A dose for [patient] at 08:00 has no answer recorded".
- iOS `interruptionLevel: 'timeSensitive'`; Android channel `caregiver_alerts_v1`.
- Tapping opens the patient's Today view for the caregiver, with the dose highlighted.
- **Exactly once** per dose: `alert_sent_at` is set in the same transaction that queues the notification.

## Not taken

A `not_taken` answer alerts the caregiver **immediately** ([D-045](01-decisions.md#d-045-not-taken-alert)): queued in the dose-response transaction. "[Patient] answered Not taken for [medicine, amount] at [time]". Kind `not_taken` ([D-082](01-decisions.md#d-082-schema-additions)). The push is generic text per D-077. Setting `alert_sent_at` on that dose stops the sweeper from also sending a missed alert.

## Grouping

Several misses for one patient within **15 minutes** arrive as **one grouped alert** ([D-046](01-decisions.md#d-046-grouping)). This must not delay the first alert, given the 2-minute SLO ([12](12-testing-and-slos.md#slos)):

1. Within one sweeper run, misses for the same patient are combined into one notification.
2. If a `missed` alert for the same patient was sent in the last 15 minutes, the new alert **replaces** it on the caregiver's phone. It uses the same `group_key` as `collapseId` (iOS) / `tag` (Android), and its text covers all misses in the group: "No answer recorded for 3 doses for [patient] (08:00 Metformin, 08:00 Amlodipine, 08:10 Vitamin D)".
3. The group window starts at the first alert; a miss more than 15 minutes after it starts a new group.

Each dose still gets its own `alert_sent_at`. `notification_log` keeps one row per sent notification with the `group_key`.

## Corrections

A patient can still answer a missed dose ([D-032](01-decisions.md#d-032-late-answers)). When a `taken` or `not_taken` answer arrives for a dose with `status = 'missed'`:
- Status flips to the answer. `responded_at` and `received_at` are recorded.
- The caregiver gets a short **correction** (kind `correction`): "Update: [medicine] at 08:00 was marked Taken at 08:52". Not taken corrections use the Not taken wording.
- One correction per dose.

## Self profile

A missed dose on a self profile notifies only the owner, **once** ([D-048](01-decisions.md#d-048-self-profile-quiet-hours-delay-changes)). The owner is also the patient, and the alert goes to their caregiver login device. If the self-profile alarm already fired on that phone, that's still the one allowed alert. No correction pushes for self profiles (the owner answered it themselves); history still updates.

## No quiet hours

Missed-dose alerts have no quiet hours in v1 ([D-048](01-decisions.md#d-048-self-profile-quiet-hours-delay-changes)). They're sent whenever due.

## Device problem alerts

A separate alert type (kind `device_health`) from the `device-health` job, every 15 min ([D-047](01-decisions.md#d-047-device-problem-alert)). For each active patient device of an `active` patient:

| Trigger | Condition |
| --- | --- |
| No heartbeat | `last_seen_at < now() − 6 h` **and** the patient has doses scheduled in the next 24 h |
| Permission off | Any required permission false in the last heartbeat (notifications; Android exact alarm, battery unrestricted; iOS time-sensitive), including permissions skipped at setup ([D-042](01-decisions.md#d-042-mandatory-guided-patient-setup)) |
| Window low | `scheduled_through < now() + 24 h` while doses exist beyond it |
| Push token invalid | `push_invalid_at is not null` (from `DeviceNotRegistered`) |

- **At most one per 12 hours per device**: skip if `notification_log` has a `device_health` row for this device in the last 12 h.
- Text names the device and the fix: "[Patient]'s Pixel 8: exact alarms are off. Ask them to open the app and follow the setup steps." Several problems on one device are combined in one alert.
- The window-low case also sends the patient's device the visible push "Open the app to keep reminders on schedule" ([D-039](01-decisions.md#d-039-refill-paths); at most once per 12 h per device, [D-093](01-decisions.md#d-093-window-low-push-throttle)).
- Caregiver UI shows a live health badge per device from the same rules, so the alert and the screen always agree.

## Implementation notes

- A `not_taken` answer on a **self profile** sends no alert (the owner just tapped it themselves), like corrections.
- A time zone change that follows the phone (D-086) tells the caregiver with a `pairing`-kind push (event `timezone_changed`).
- Misses are grouped by `group_key` and a running `count` in `notification_log.data`; the phone replaces the earlier alert (Android `tag`, iOS `collapseId`).

## Edge cases

| Case | Behaviour |
| --- | --- |
| Patient answered offline before the deadline; answer arrives after the alert | Missed alert already sent. Answer flips status, correction sent ("…was marked Taken at 08:05", using `responded_at`) |
| Sweeper down for 10 minutes | Next run sends all overdue alerts (selection by time). Lag is visible on the dashboard |
| Medicine archived after the dose was due but before the deadline | Past doses are not deleted, so the alert still fires |
| Patient suspended at cutoff with doses still pending | No alerts for suspended patients (excluded by join) |
| Transfer between scheduled time and deadline | Alert goes to the new owner (owner resolved at send time) |
