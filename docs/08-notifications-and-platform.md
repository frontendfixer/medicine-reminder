# Notifications and platform

Notification types, Android channels, exact alarms, battery optimisation, iOS interruption levels, permission onboarding and lock-screen actions. Every item here was checked against current platform docs and store policy on 2026-10-28 ([references](references.md)). Items that differ from the agreed decisions point to conflicts in [01-decisions](01-decisions.md#conflicts-found-while-documenting).

Library: `expo-notifications` 58.1.6 (Expo SDK 58), development build only ([D-001](01-decisions.md#d-001-expo-development-build-one-app-with-two-modes)).

## Notification types

Per medicine, `medicines.notification_type` ([D-025](01-decisions.md#d-025-three-notification-types)):

| Type | Intent | Android | iOS |
| --- | --- | --- | --- |
| `standard` (default) | Normal reminder | Channel `dose_standard_v1`, importance HIGH, default sound | `interruptionLevel: 'timeSensitive'` ([D-027](01-decisions.md#d-027-ios-interruption-levels)) |
| `alarm` | Loud; local follow-ups every **5 minutes** until answered or the missed delay ends | Channel `dose_alarm_v1`, importance HIGH (MAX if supported), custom long sound, vibration, `bypassDnd` requested (user-controlled) ([D-094](01-decisions.md#d-094-alarm-and-gentle-sounds)). Scheduled with `delivery: 'alarmClock'` ([D-072](01-decisions.md#d-072-alarm-type-uses-alarm-clock-delivery)) | `timeSensitive`, custom sound. Later: `critical` with the Critical Alerts entitlement |
| `gentle` | Quiet reminder | Channel `dose_gentle_v1`, importance DEFAULT, no sound override | `interruptionLevel: 'active'` |

Other channels: `caregiver_alerts_v1` (missed, not taken, corrections, device problems; HIGH), `system_v1` (window low, sign-out notice, billing; DEFAULT).

## Android channels

([D-026](01-decisions.md#d-026-android-channels))
- Created at first launch, **before** requesting notification permission: on Android 13+ the permission prompt doesn't appear until a channel exists ([R-02](references.md)).
- **Channel settings can't change after creation**; only name and description can ([R-02](references.md), [R-30](references.md)). IDs are versioned (`dose_alarm_v1` → `dose_alarm_v2`). To change behaviour, create the new ID, migrate scheduling to it and delete the old channel. Android shows a deleted-channel count in settings, so do this rarely.
- The user has final control over channel settings. The heartbeat doesn't report per-channel state in v1. A user muting `dose_alarm_v1` isn't detected (risk in [11](11-failure-modes.md)).
- Lock-screen visibility: public for `full` detail. With `generic`, scheduled content itself uses generic text (we don't rely on `VISIBILITY_PRIVATE` redaction).

## Exact alarms (Android)

Findings ([R-02](references.md), [R-27](references.md), [R-28](references.md), [R-33](references.md)) → see [D-073](01-decisions.md#d-073-schedule_exact_alarm-only):

| Fact | Consequence |
| --- | --- |
| Exact timing on Android 12+ needs `SCHEDULE_EXACT_ALARM` | Declare it; check with `getExactAlarmPermissionsAsync`, request with `requestExactAlarmPermissionsAsync` (opens the system "Alarms & reminders" screen) |
| Android 14+ denies it by default for new installs targeting 13+; backup-restore doesn't carry it | Guided setup must ask for it on every new install |
| Without it, notifications arrive at an approximate time; `delivery: 'alarmClock'` falls back to `'bestEffort'` | Report `exact_alarm = false` in heartbeat. It is a required permission, so conditional push applies (D-036) and the caregiver is told (D-042, D-047) |
| Revoking it **cancels all future exact alarms** and stops the app | On next app open or background run, re-schedule the full window |
| `USE_EXACT_ALARM` is Play-restricted to alarm/timer and calendar apps | Don't declare it. CI checks the merged `AndroidManifest.xml` for it |
| Doze: `setExactAndAllowWhileIdle` max once per 9 min per app; `setAlarmClock` exits Doze | Alarm-type doses and follow-ups use `delivery: 'alarmClock'` ([D-072](01-decisions.md#d-072-alarm-type-uses-alarm-clock-delivery)). Phase 0 verifies whether Standard/Gentle also need it when several doses fall within 9 minutes |

`USE_FULL_SCREEN_INTENT` is auto-granted only to alarm and calling apps on Play ([R-33](references.md)). Full-screen intents aren't part of the decisions and aren't used.

## Battery optimisation (Android)

- Doze defers standard alarms, network, jobs and WorkManager; App Standby defers network for idle apps ([R-29](references.md)).
- Being exempt from battery optimisation lets the app use the network and hold wake locks in Doze, which helps refill and heartbeat. Alarms are still governed by the alarm APIs above.
- **Play policy:** the direct request dialog (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` + `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission) is only for acceptable use cases, and medication reminders aren't listed. We don't declare that permission; guided setup opens the settings list (`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`) with guidance ([D-074](01-decisions.md#d-074-battery-optimisation-via-the-settings-list)).
- Check state with `isBatteryOptimizationEnabledAsync()` from `expo-battery` (Android 6+, no extra permission); `battery_unrestricted = !enabled` ([R-49](references.md)). No native module needed. Open the list with `expo-intent-launcher` `ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS` ([R-50](references.md)).
- OEM layers (Samsung, Xiaomi/MIUI/HyperOS, Oppo/ColorOS) add their own background killers. Phase 5 adds OEM-specific guidance screens, tested on the device matrix ([12](12-testing-and-slos.md#device-matrix)).

## iOS interruption levels

([R-36](references.md), [R-37](references.md))

| Level | Behaviour (Apple) | Use |
| --- | --- | --- |
| `passive` | Added to the list without lighting the screen or sound | Not used |
| `active` | Presents immediately, lights the screen, can play sound | Gentle; caregiver info pushes |
| `timeSensitive` | Presents immediately, can play sound, "breaks through system notification controls" (Focus, Scheduled Summary) | Standard, Alarm; missed-dose alerts to caregiver |
| `critical` | Bypasses the mute switch; needs the Critical Alerts entitlement + user permission | After launch: Alarm, if Apple grants the entitlement ([D-027](01-decisions.md#d-027-ios-interruption-levels)) |

- Enable the Time Sensitive Notifications capability in the iOS project via `ios.entitlements` (`com.apple.developer.usernotifications.time-sensitive`; the expo-notifications plugin has no option for it, [R-02](references.md), [R-55](references.md)). Users can turn time-sensitive off per app. That state is reported as `time_sensitive` and treated as a required permission.
- **Reading `time_sensitive`:** expo-notifications 58.1.6 doesn't expose it (`NotificationPermissionsStatus.ios` has no such field, [R-02](references.md)). It needs a small Expo Modules API native module reading `UNNotificationSettings.timeSensitiveSetting`, built in Phase 3 alongside any D-076 fallback. Until then the heartbeat can't report it.
- **Critical Alerts:** apply after launch via Apple's request form ([R-37](references.md)), with the justification: patients who miss medicines due to silent mode; caregiver-configured per medicine.
- **64 pending requests per app** ([R-39](references.md)): budget in [05](05-reminder-engine.md#window-size).
- Notification attachments (`attachments`, iOS only) show the cached medicine photo when the lock-screen detail is `full` ([D-079](01-decisions.md#d-079-no-photo-in-android-notifications)).

## Lock-screen detail

([D-028](01-decisions.md#d-028-lock-screen-detail))

| Setting | Title | Body | Photo |
| --- | --- | --- | --- |
| `full` (default) | "Metformin 500 — 1 tablet" | "Due 08:00" | iOS attachment; Android: no ([D-079](01-decisions.md#d-079-no-photo-in-android-notifications)) |
| `generic` | "Medicine reminder" | "Due 08:00 — tap to see" | none |

Resolution: `patients.lockscreen_detail` (per-patient override, D-082) → `caregiver_settings.lockscreen_detail`. A change triggers a re-sync, which re-schedules every notification with the new content. **Remote pushes** (backup, alerts) carry generic text plus IDs regardless of setting ([D-077](01-decisions.md#d-077-generic-text-in-remote-pushes-app-works-without-notifications)).

## Lock-screen actions

([D-029](01-decisions.md#d-029-answer-options))
- Category `dose_v1` registered at launch with `setNotificationCategoryAsync`. Actions:
  - `TAKEN` — "Taken", `opensAppToForeground: false`
  - `NOT_TAKEN` — "Not taken", `opensAppToForeground: false`
  - `SNOOZE_10` — "Snooze 10 min", `opensAppToForeground: false`. Omitted when `now + 10 min ≥ alert_due_at` ([D-085](01-decisions.md#d-085-answer-merge-and-snooze-cut-off)), using a second category `dose_nosnooze_v1`. Alarm follow-ups late in the window use it.
- Every local and backup notification uses this category with `data: { dose_id, patient_id }`.
- **Handling:**
  - Android: `registerTaskAsync` runs the JS task for action taps even when the app is terminated ([R-02](references.md)). The task writes the outbox row and cancels follow-ups.
  - iOS: the system launches the app in the background and calls `didReceive` ([R-40](references.md)), but expo-notifications documents its background task for action taps as Android-only. **Phase 0 must prove this works on iOS** or pick a fallback ([D-076](01-decisions.md#d-076-ios-lock-screen-answers-proven-in-phase-0)).
- The Today screen offers the same three answers with large buttons, photo and amount. It works with notifications disabled ([D-077](01-decisions.md#d-077-generic-text-in-remote-pushes-app-works-without-notifications)).

## Permission onboarding

Mandatory guided first-run step for patient profiles (including the self profile) ([D-042](01-decisions.md#d-042-mandatory-guided-patient-setup)). One screen per permission, each with: why, a button that opens the system prompt or settings, and *Skip*. **Each skipped permission is reported to the caregiver** (heartbeat → device problem alert).

| Step | Android | iOS |
| --- | --- | --- |
| 1. Notifications | `POST_NOTIFICATIONS` runtime prompt (Android 13+; off by default for new installs, [R-31](references.md)). Create channels first | Request alert, sound, badge |
| 2. Exact alarms | "Alarms & reminders" settings screen (`SCHEDULE_EXACT_ALARM`) | — |
| 3. Battery | Battery-optimisation settings list + OEM guidance ([D-074](01-decisions.md#d-074-battery-optimisation-via-the-settings-list)) | — |
| 4. Time-sensitive | — | Explain; if disabled, deep-link to app notification settings |
| 5. Test | Schedule a test notification 10 s ahead (verifies channel and sound) | Same |

- The app must keep working when any permission is refused (Apple 4.5.4, [D-077](01-decisions.md#d-077-generic-text-in-remote-pushes-app-works-without-notifications)). The Today screen remains usable.
- Permissions are re-checked on every app open and in the background task. A permission turned off later is reported the same way.
- Caregiver mode asks only for notifications (for alerts).

## Push (remote)

- Expo Push Service → FCM/APNs ([D-061](01-decisions.md#d-061-push), [R-08](references.md)).
- Visible pushes set `channelId` (Android), `interruptionLevel` (iOS), `categoryId` (dose backups) and `collapseId` (grouped alerts, [09](09-missed-dose-alerts.md#grouping)).
- Data pushes (`sync`, `dose_cleared`, `cancel_all`): `data` only, `priority: 'high'` on Android, `contentAvailable: true` on iOS. Handled by the `registerTaskAsync` background task. All best effort ([D-075](01-decisions.md#d-075-data-pushes-are-best-effort)).
- iOS needs `remote-notification` in `UIBackgroundModes` (`enableBackgroundRemoteNotifications` in the config plugin).
- Payload ≤ 4 KiB.

## Store policy checklist

| Store | Item | Source |
| --- | --- | --- |
| Play | `SCHEDULE_EXACT_ALARM` justification in listing and review notes; no `USE_EXACT_ALARM` | [R-33](references.md), [D-073](01-decisions.md#d-073-schedule_exact_alarm-only) |
| Play | No `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`; settings-list guidance only | [R-29](references.md), [D-074](01-decisions.md#d-074-battery-optimisation-via-the-settings-list) |
| Play | Health apps declaration: *Medication and Treatment Management* | [R-34](references.md), [D-088](01-decisions.md#d-088-store-declarations) |
| Apple | Time-sensitive capability; Critical Alerts request (post-launch) | [R-37](references.md) |
| Apple | 1.4.1 disclaimer (consult a doctor); 4.5.4 push not required, no sensitive data in push; 5.1.1(v) in-app account deletion; 4.8 not triggered in v1 (email + password only, D-095) — Sign in with Apple must ship with Google sign-in in v1.1 | [R-42](references.md) |
