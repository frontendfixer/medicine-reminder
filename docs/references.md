# References

Every source opened while writing these docs. When you consult a source to implement or change something, add or update its row in the same change (see [CLAUDE.md](../CLAUDE.md)).

All entries were checked on **2026-10-28** unless stated otherwise.

## Mobile (Expo / React Native)

| # | Title | URL | Version / note |
| --- | --- | --- | --- |
| R-01 | Expo SDK reference (latest) | https://docs.expo.dev/versions/latest/ | Expo SDK 58.0.0 · React Native 0.88 · React 19.3.0 · min iOS 16.4 (Xcode 26.4+) · min Android 7 · compileSdk 37 · targetSdk 36 |
| R-02 | Expo Notifications | https://docs.expo.dev/versions/latest/sdk/notifications/ | expo-notifications 58.1.6. Channels immutable after creation except name/description; `SCHEDULE_EXACT_ALARM` needed for exact timing on Android 12+, denied by default on 14+; `delivery: 'alarmClock'` needs exact-alarm permission, else falls back to `'bestEffort'`; `USE_EXACT_ALARM` Play-restricted; `interruptionLevel` (iOS) passive/active/timeSensitive/critical; `attachments` iOS only; `registerTaskAsync` runs for action taps in background/terminated **only on Android**; remote push on Android not in Expo Go since SDK 53 |
| R-03 | Expo BackgroundTask | https://docs.expo.dev/versions/latest/sdk/background-task/ | expo-background-task 58.0.11. WorkManager (Android, min 15 min) / BGTaskScheduler (iOS, system-chosen). Stops when user force-quits on iOS |
| R-04 | Expo SecureStore | https://docs.expo.dev/versions/latest/sdk/securestore/ | expo-secure-store 58.0.2. iOS Keychain (`AFTER_FIRST_UNLOCK` for background access), Android Keystore-encrypted SharedPreferences; ~2048-byte value warning on some iOS versions; backup exclusion via config plugin |
| R-05 | Expo SQLite | https://docs.expo.dev/versions/latest/sdk/sqlite/ | expo-sqlite 58.0.14. Sync + async APIs, `withExclusiveTransactionAsync`, WAL recommended, optional SQLCipher via `useSQLCipher` |
| R-06 | Expo AppIntegrity | https://docs.expo.dev/versions/latest/sdk/app-integrity/ | @expo/app-integrity 58.0.2. Wraps Play Integrity (standard requests) and App Attest |
| R-07 | Expo development builds — introduction | https://docs.expo.dev/develop/development-builds/introduction/ | expo-dev-client 58.0.16 |
| R-08 | Expo Push Service — sending notifications | https://docs.expo.dev/push-notifications/sending-notifications/ | expo-server-sdk 8.0.0. 100 msgs/request, 600 notifications/s/project, receipts ready ~15 min, deleted after 24 h, `DeviceNotRegistered`, `contentAvailable`, `richContent.image` needs iOS Notification Service Extension, optional access-token "enhanced security" |
| R-09 | EAS Update — rollouts | https://docs.expo.dev/eas-update/rollouts/ | eas-cli 26.0.0. Per-update `--rollout-percentage`, `eas update:revert-update-rollout`, branch-based `eas channel:rollout` |
| R-10 | npm registry (version check of every package named in docs) | https://registry.npmjs.org/ | expo 58.0.20, expo-updates 58.0.18, expo-camera 58.0.13, expo-image-picker 58.0.10, expo-image-manipulator 58.0.15, expo-localization 58.0.5, expo-apple-authentication 58.0.2, @react-native-google-signin/google-signin 16.1.5, react-native 0.88.1, react-native-purchases 10.16.0, @sentry/react-native 8.32.0, i18next 26.5.11, react-i18next 17.1.9 |

## Backend

| # | Title | URL | Version / note |
| --- | --- | --- | --- |
| R-11 | Node.js previous releases | https://nodejs.org/en/about/previous-releases | v26 Current → LTS, v24 "Krypton" LTS, v22 "Jod" LTS |
| R-12 | Node.js release schedule (schedule.json) | https://raw.githubusercontent.com/nodejs/Release/main/schedule.json | v26: LTS 2026-10-28, maintenance 2027-10-20, end 2029-04-30. v24: maintenance from 2026-10-20, end 2028-04-30. Latest v26 release 26.12.1 (2026-10-21) |
| R-13 | NestJS migration guide (v11 → v12) | https://docs.nestjs.com/migration-guide | @nestjs/core 12.3.2. ESM-only packages; runtime Node 20.19+/22.12+; CLI Node 22.22.3+/24.15+/26+; Jest needs Node 24.9+ for ESM packages, otherwise Vitest. @nestjs/bullmq 12.0.0, @nestjs/jwt 12.0.3, @nestjs/throttler 6.7.1 |
| R-14 | Drizzle ORM — indexes & constraints | https://orm.drizzle.team/docs/indexes-constraints | drizzle-orm 0.45.4 (npm `latest`), 1.0.0-rc.5 on `rc` tag; drizzle-kit 0.31.11. Table callback returns an array; partial index via `.where(sql\`…\`)` |
| R-15 | BullMQ — Job Schedulers | https://docs.bullmq.io/guide/job-schedulers | bullmq 6.5.0. `upsertJobScheduler(id, {every \| pattern}, template)`; next job produced only when the previous one starts processing |
| R-16 | BullMQ — Repeatable (legacy) | https://docs.bullmq.io/guide/jobs/repeatable | Repeat API deprecated in 5.16.0 and **removed in v6** |
| R-17 | BullMQ — Going to production | https://docs.bullmq.io/guide/going-to-production | Redis AOF persistence, `maxmemory-policy noeviction`, `maxRetriesPerRequest: null` for workers, graceful shutdown on SIGTERM. Minimum Redis version not stated — verify in Phase 1 |
| R-18 | PostgreSQL versioning policy | https://www.postgresql.org/support/versioning/ | PostgreSQL 18 (18.6) newest supported; 19 at RC 1, not yet supported |
| R-19 | Cloudflare R2 — presigned URLs | https://developers.cloudflare.com/r2/api/s3/presigned-urls/ | GET/HEAD/PUT/DELETE only (no POST forms); expiry 1 s – 7 days; Content-Type can be signed; no custom domains; URLs are bearer tokens. @aws-sdk/client-s3 + s3-request-presigner 3.1158.0 |
| R-20 | Sentry React Native — sensitive data | https://docs.sentry.io/platforms/react-native/data-management/sensitive-data/ | `beforeSend`, `beforeBreadcrumb`, server-side scrubbing, optional Relay. @sentry/nestjs 11.9.0 |

## Billing

| # | Title | URL | Version / note |
| --- | --- | --- | --- |
| R-21 | RevenueCat — Webhooks | https://www.revenuecat.com/docs/integrations/webhooks | Pro plan feature; authorization header + optional HMAC (`X-RevenueCat-Webhook-Signature`); 200 within 60 s; 5 retries (~2.5→40 min); dedupe on event `id`; recommended: re-fetch customer after each event |
| R-22 | RevenueCat — Event types and fields | https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields | `INITIAL_PURCHASE`, `RENEWAL`, `CANCELLATION`, `UNCANCELLATION`, `EXPIRATION`, `BILLING_ISSUE` (`grace_period_expiration_at_ms`), `PRODUCT_CHANGE`, `SUBSCRIPTION_PAUSED`, `SUBSCRIPTION_EXTENDED`, `TRANSFER`, `TEMPORARY_ENTITLEMENT_GRANT`, … |
| R-23 | RevenueCat — How grace periods work | https://www.revenuecat.com/docs/subscription-guidance/how-grace-periods-work | Access continues during store grace once the store reports it; cancellation events are sent on entering grace |
| R-24 | RevenueCat — REST API v2 | https://www.revenuecat.com/docs/api-v2 | Base `https://api.revenuecat.com/v2`, Bearer secret key, `gives_access` on subscriptions, Customer Information 480 req/min |
| R-25 | Google Play Billing — subscription lifecycle | https://developer.android.com/google/play/billing/lifecycle/subscriptions | Silent grace ≥ 1 day, grace period (entitlement kept), account hold (entitlement lost; default 60 days minus grace), `SUBSCRIPTION_EXPIRED` |
| R-26 | App Store Connect — Billing Grace Period | https://developer.apple.com/help/app-store-connect/manage-subscriptions/enable-billing-grace-period-for-auto-renewable-subscriptions | 3, 16 or 28 days (weekly capped at 6); access kept during grace |

## Platform behaviour and store policy

| # | Title | URL | Version / note |
| --- | --- | --- | --- |
| R-27 | Android — Schedule alarms | https://developer.android.com/develop/background-work/services/alarms/schedule | `SCHEDULE_EXACT_ALARM` vs `USE_EXACT_ALARM`; revoking `SCHEDULE_EXACT_ALARM` stops the app and cancels all future exact alarms; `setAlarmClock` exits Doze |
| R-28 | Android 14 — Schedule exact alarms denied by default | https://developer.android.com/about/versions/14/changes/schedule-exact-alarms | Not pre-granted to new installs targeting 13+; `ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED` |
| R-29 | Android — Doze and App Standby | https://developer.android.com/training/monitoring-device-state/doze-standby | `setExactAndAllowWhileIdle` max once per 9 min per app in Doze; `setAlarmClock` still fires; battery-exemption acceptable-use table; FCM v2 `RemoteNotification` vs `BackgroundSync` |
| R-30 | Android — Notification channels | https://developer.android.com/develop/ui/views/notifications/channels | Only name and description can change after creation; importance fixed |
| R-31 | Android — Notification runtime permission | https://developer.android.com/develop/ui/views/notifications/notification-permission | `POST_NOTIFICATIONS` on Android 13+; off by default for new installs |
| R-32 | Firebase — Android message priority | https://firebase.google.com/docs/cloud-messaging/android/message-priority | Page last updated 2026-10-27. High priority must lead to user-visible notifications or is deprioritised (7-day behaviour window); move to `AndroidConfigV2` (`RemoteNotification` / `BackgroundSync`) |
| R-33 | Play Console Help — Permissions and APIs that access sensitive information | https://support.google.com/googleplay/android-developer/answer/16558241 | `USE_EXACT_ALARM` only for alarm/timer or calendar apps (Play Console declaration); otherwise `SCHEDULE_EXACT_ALARM`. `USE_FULL_SCREEN_INTENT` auto-granted only for alarms and calls |
| R-34 | Play Console Help — Health apps declaration | https://support.google.com/googleplay/android-developer/answer/14738291 | Every app must complete it; category **Medication and Treatment Management** covers medication reminders |
| R-35 | Play Integrity API overview | https://developer.android.com/google/play/integrity/overview | Standard vs classic requests; verdicts; default 10,000 requests/day; plan for outages |
| R-36 | Apple — UNNotificationInterruptionLevel | https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel | Read via `developer.apple.com/tutorials/data/documentation/usernotifications/unnotificationinterruptionlevel.md`. iOS 15+; timeSensitive "breaks through system notification controls"; critical bypasses mute switch |
| R-37 | Apple — Critical Alerts entitlement | https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.critical-alerts | Request form: https://developer.apple.com/contact/request/notifications-critical-alerts-entitlement/ |
| R-38 | Apple — Scheduling a notification locally from your app | https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app | Page does **not** state the pending-request limit |
| R-39 | Apple Developer Forums — "Does UNNotificationRequest have a 64-notification scheduling limit?" | https://developer.apple.com/forums/thread/811171 | Apple staff answer (Jan 2026): limit of 64 simultaneous pending requests per app, no workaround. Forum answer, not reference docs — re-verify each iOS release |
| R-40 | Apple — Handling notifications and notification-related actions | https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions | Action tap launches the app in the background and calls `didReceive` |
| R-41 | Apple — Establishing your app's integrity (App Attest) | https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity | `isSupported`, `generateKey`, `attestKey` with ≥16-byte server challenge, assertions; keys don't survive reinstall |
| R-42 | App Store Review Guidelines | https://developer.apple.com/app-store/review/guidelines/ | 1.4.1 medical apps (remind users to consult a doctor), 3.1.2 subscriptions, 4.5.4 push not required and no sensitive personal data in push, 4.8 login services, 5.1.1(v) in-app account deletion, 5.1.3 health data |

## Security guidance

| # | Title | URL | Version / note |
| --- | --- | --- | --- |
| R-47 | OWASP Password Storage Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html | Argon2id minimum m = 19 MiB (19456 KiB), t = 2, p = 1; scrypt / bcrypt fallbacks; pepper in a vault. npm: `@node-rs/argon2` 2.2.2, `argon2` 0.45.1 |
| R-48 | OWASP Authentication Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html | Without MFA, passwords under 15 characters are weak; max ≥ 64; no composition rules; block breached passwords (Pwned Passwords); generic errors with consistent timing; throttle per account; avoid lockout DoS; re-authenticate for sensitive actions |

## Law (India)

| # | Title | URL | Version / note |
| --- | --- | --- | --- |
| R-43 | Digital Personal Data Protection Act, 2023 (No. 22 of 2023), official Gazette text | https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf | Assent 11 Aug 2023. s.6 consent & withdrawal, s.8(7) erasure, s.8(9) contact, s.8(10) grievance, s.9 children/guardians (no tracking or behavioural monitoring of children), s.11–14 rights |
| R-44 | Digital Personal Data Protection Rules, 2025 — G.S.R. 846(E), 13 Nov 2025 (MeitY) | https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf | Rules 1, 2, 17–21 in force 13 Nov 2025; Rule 4 after 1 year; Rules 3, 5–16, 22, 23 after 18 months (**13 May 2027**). Rule 3 notice, 6 security (incl. 1-year log retention), 7 breach (Board within 72 h), 8(3) ≥ 1-year retention of processing logs, 9 contact, 10 child consent, 11 guardian consent, 14 rights (grievance ≤ 90 days) |
| R-45 | MeitY document listed as "corrigendum" (Jan 2026) | https://www.meity.gov.in/static/uploads/2026/01/a49c50414777afc2af0b8d59dafacd60.pdf | Opened: it is a summary of public-consultation feedback on the draft Rules, **not** a corrigendum. No effect on these docs |
| R-46 | MeitY data protection framework page | https://www.meity.gov.in/data-protection-framework | Returned HTTP 403 on 2026-10-28; official PDFs above were fetched directly |

## Not yet checked (check before the phase that needs it)

- Redis minimum version for BullMQ 6 (Phase 1).
- Sign in with Apple / Google Sign-In server verification docs (v1.1, D-095).
- expo-image-manipulator EXIF behaviour (Phase 2).
- EAS Build profiles and store staged-rollout docs for Play Console and App Store phased release (Phase 5).
- Play Data safety form and App Store privacy details (Phase 5).
- Android 16 / iOS 26 notification behaviour changes for the targeted SDKs (Phase 0).
