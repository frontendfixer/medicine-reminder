# Phase 0 — Reminder spike

Throwaway code for [Phase 0](../docs/13-roadmap.md#phase-0--reminder-spike-1-week). It proves local reminders and lock-screen answers work on real phones with the app killed. Nothing here is reused in Phase 1. Findings go into the docs, not into this folder.

- `reminder-app/`: Expo SDK 58 development build. One debug screen, plus SQLite for an event log and the answer outbox.
- `stub-server/`: a Node HTTP server with no dependencies. It stands in for `POST /v1/device/dose-responses` and sends Expo data pushes.

No real medicine names, photos or personal data. Doses are labelled "Test dose N".

## Setup (owner)

These steps need your accounts and can't be done by an agent:

1. **EAS project:** `cd reminder-app && eas init` (sets the project ID). Then `export EAS_PROJECT_ID=<id>` for every build, or add it to the `development` profile `env` in `eas.json`.
2. **Android push (FCM v1):** create a Firebase project, put `google-services.json` in `reminder-app/` (gitignored), and upload the FCM v1 service-account key with `eas credentials`.
3. **iOS:** an Apple Developer account. Register the device with `eas device:create`. The build enables the Time Sensitive Notifications entitlement (`com.apple.developer.usernotifications.time-sensitive`). Check that the provisioning profile has it.
4. **Bundle IDs:** the defaults are `com.medreminder.spike`. Override them with `SPIKE_IOS_BUNDLE_ID` / `SPIKE_ANDROID_PACKAGE`.
5. **Stub URL:** run `node stub-server/server.mjs` on a machine the phones can reach, for example over a LAN IP or a tunnel. Build with `SPIKE_STUB_URL=http://<host>:8787`.
6. **Build:** `eas build --profile development --platform all`, then install on the four phones in the [device matrix](../docs/12-testing-and-slos.md#device-matrix).

`SPIKE_STUB_URL` and `EAS_PROJECT_ID` are read at build time (`app.config.ts`), so set them before `eas build`.

## What the app does on launch

In this order: create channels `dose_standard_v1` / `dose_alarm_v1` / `dose_gentle_v1`, then register categories `dose_v1` and `dose_nosnooze_v1` (the permission prompt can't appear before this). Next it registers the notification task and the background task. Then it handles any tap that launched the app, logs which notifications are in the shade with their delivery time, and flushes the outbox.

Every answer path writes a row with `source`:

| `source` | Meaning |
| --- | --- |
| `android_task` | Headless task ran for the action tap (app killed or backgrounded) |
| `listener` | Response listener ran with JS already alive |
| `last_response_on_launch` | The tap was picked up only when the app was next opened. **On iOS this means the D-076 test failed** |

Use **Copy log as JSON** after each run and paste it into the results below.

## Test protocol

Run each test on every phone in each state from doc 12: **locked**, **idle overnight** (≥ 8 h, unplugged), **battery saver on**. Before each run, swipe the app away from recents. Record the OS version and build number.

| # | Roadmap item | How | Pass when |
| --- | --- | --- | --- |
| 1 | Channels before permission prompt | Fresh install, open app, tap *Request notification permission* | Android 13+ prompt appears; three channels listed in system settings |
| 2 | Category `dose_v1` actions | *Test notification in 10 s*, lock phone | Taken / Not taken / Snooze 10 min shown on the lock screen for all three types |
| 3 | Dose-ID identifiers; re-sync | *Schedule test window*, note `pending`, tap *Re-sync same window* | `pending_after` equals `pending_before` in the `window_resync` log event |
| 4 | Alarm follow-ups, `alarmClock` (D-072) | *Alarm dose in 2 min + follow-ups*, kill app, lock; Android also `adb shell dumpsys deviceidle force-idle` | 7 notifications at 5-minute intervals, each `late_seconds` < 60 |
| 5 | Standard/Gentle in Doze (D-072 open question) | Android, Doze forced: *Doze cluster (bestEffort)*, then on a later run *(alarmClock)* | Record `late_seconds` for each of the 3. If bestEffort lags > 60 s, Standard/Gentle need `alarmClock` too → log a conflict |
| 6 | Exact-alarm flow (D-073) | Fresh install on Android 14+: status shows `exact_alarm: false`; *Open Alarms & reminders*; grant; reopen. Then revoke in settings and reopen | Status flips each way; after revoke, `pending` shows what survived. Record it |
| 7 | No `USE_EXACT_ALARM` (D-073) | After a build with `android/` present: `./gradlew :app:processReleaseMainManifest && ./scripts/check-manifest.sh` | Script prints OK |
| 8 | Battery state (D-074) | *Open battery optimisation list*, set the app to unrestricted, return, *Refresh status* | `battery_unrestricted` flips to `true` |
| 9 | iOS time-sensitive + Focus | Enable a Focus mode that blocks the app; run *Test notification in 10 s* | Standard/Alarm break through, Gentle doesn't. Record per type |
| 10 | Lock-screen answer, app killed (D-076) | *Device test script*, kill the app, answer from the lock screen without unlocking, wait 5 min, open app | Android: rows with `source = android_task`. iOS: anything other than `last_response_on_launch`; otherwise build the native-module fallback |
| 11 | SQLite persist + flush | Same as 10 with the stub running; then airplane mode, answer, network back, open | Stub `GET /answers` lists every answer once; offline ones arrive after reconnect |
| 12 | iOS 64 limit (D-078) | iPhone: *Cancel all*, then *iOS: schedule 70 requests* | `fill_70` event: record `pending_total` and which IDs were `dropped` (expected 64 kept) |
| 13 | iOS photo attachment (D-079) | *Photo attachment in 30 s*, lock phone | Blue square thumbnail visible; long-press shows it |
| 14 | Background task frequency | Leave the phone overnight | Count `background_task` events and the gaps between them, per phone |
| 15 | Data push to killed app (D-075) | *Copy Expo push token*, kill the app, `curl -XPOST <stub>/push -d '{"to":"<token>","kind":"sync"}'` (repeat 10× over a day, idle) | Count `data_push` events against pushes sent; check `/receipts` |
| 16 | Overnight gate | *Device test script* at night, kill app, unplug, sleep; answer 07:00 from the lock screen | All doses `late_seconds` < 60, all follow-ups present, answers flushed, on all 4 phones |

`late_seconds` comes from the `presented` events. The app records each notification's OS delivery time the next time it opens or the background task runs. A notification you swipe away before then has no record, so leave them in the shade until you open the app.

## Results

Fill in one row per phone per run. Then move the conclusions into the docs (roadmap gate result, references, decisions/conflicts) and keep the raw log JSON outside the repo.

| Date | Phone / OS | Build | Test # | State | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

## Known gaps in this spike

- **iOS time-sensitive state:** expo-notifications 58.1.6 has no field for it. The status shows `time_sensitive: not exposed`. Reading `UNNotificationSettings.timeSensitiveSetting` needs a small native module (same Expo Modules API route as the D-076 fallback).
- **iOS native fallback for lock-screen answers (D-076):** not built. Build it only if test 10 shows `last_response_on_launch` on iOS.
- **Merged-manifest check (test 7):** not yet run. The local Gradle run couldn't download its distribution from this machine's sandbox. The generated manifest already marks `USE_EXACT_ALARM` and `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` with `tools:node="remove"`.
