# Failure modes

Risk → mitigation. "Detect" says how we find out; most map to dashboards and alerts in [14](14-release-and-ops.md#monitoring) and SLOs in [12](12-testing-and-slos.md#slos).

## Patient phone

| # | Risk | Impact | Mitigation | Detect |
| --- | --- | --- | --- | --- |
| F-01 | App killed / force-quit (iOS swipe-away) | Background task stops ([R-03](references.md)); local notifications still fire | Local notifications are OS-held. Conditional push when the window runs short | `scheduled_through`, heartbeat age |
| F-02 | Exact-alarm permission denied or revoked (Android 14+ default deny) | Reminders late; revocation cancels all exact alarms | Guided setup; re-schedule on next run; conditional push; device problem alert ([D-073](01-decisions.md#d-073-schedule_exact_alarm-only)) | Heartbeat `perm_exact_alarm` |
| F-03 | Doze / OEM battery killers (Samsung, Xiaomi, Oppo) | Alarms deferred; Alarm follow-ups throttled to 9 min | `alarmClock` delivery for Alarm ([D-072](01-decisions.md#d-072-alarm-type-uses-alarm-clock-delivery)); battery guidance ([D-074](01-decisions.md#d-074-battery-optimisation-via-the-settings-list)); OEM tests in Phase 5 | Device matrix tests; answer latency vs scheduled time |
| F-04 | Notifications disabled, or a channel muted by the user | Silent reminders | Permission reported → backup push won't help either, so caregiver alert. Channel mute not detected in v1 | Heartbeat `perm_notifications` |
| F-05 | iOS 64-request limit exceeded | Excess notifications silently dropped | Budget allocator across profiles ([05](05-reminder-engine.md#window-size), [D-078](01-decisions.md#d-078-one-notification-budget-per-phone)); honest `scheduled_through` | Unit tests on allocator; `getAllScheduledNotificationsAsync` count in heartbeat debug |
| F-06 | Window runs out (patient never opens app) | No local reminders | Refill paths; visible "Open the app" push under 24 h; caregiver warning; conditional push covers each due dose | Window-low metric |
| F-07 | Phone offline for days | Answers not synced; caregiver sees misses | Local alarms keep firing; outbox; corrections on sync | Offline-answer latency SLO |
| F-08 | Device clock wrong | `responded_at` misleading; notification time skew | Server stores `received_at` too; clamp rule ([D-085](01-decisions.md#d-085-answer-merge-and-snooze-cut-off)); heartbeat returns `server_time` and the app warns on > 5 min skew (suggestion) | Skew metric |
| F-09 | Timezone change (travel) | Doses at wrong local time | Heartbeat tz → regenerate + caregiver notice ([D-040](01-decisions.md#d-040-timezone)) | Audit `patient.timezone_changed` |
| F-10 | iOS lock-screen answer lost when app terminated | Dose shows missed despite answer | Phase 0 verification + fallback ([D-076](01-decisions.md#d-076-ios-lock-screen-answers-proven-in-phase-0)) | Phase 0 gate |
| F-11 | App uninstalled / reinstalled | Token lost; alarms gone | Heartbeat stops → 6 h device alert; re-pair flow | Device health |
| F-12 | Push token rotated / `DeviceNotRegistered` | Backups and data pushes fail | Token in every heartbeat; receipts clear invalid tokens and flag the device | Receipt error rate |
| F-13 | Two devices answer differently | Conflicting history | Earliest answer wins; both recorded in audit; `dose_cleared` push | — |
| F-14 | Device token rejected (revoked) | No sync | Alarms keep firing; one recovery screen; caregiver alerted ([D-015](01-decisions.md#d-015-rejected-token)) | `device.token_rejected` audit |
| F-15 | Billing cutoff command never reaches iOS phone | Alarms fire for a suspended patient | Grace-window cap ([D-087](01-decisions.md#d-087-grace-trigger-and-grace-capped-windows)); cancel on next open | Answers arriving for suspended patients |

## Server

| # | Risk | Impact | Mitigation | Detect |
| --- | --- | --- | --- | --- |
| F-20 | Redis lost / flushed | Job triggers lost | All state in Postgres; Job Schedulers re-upserted on worker boot; sweeper catches up by time ([D-033](01-decisions.md#d-033-postgres-is-the-source-of-truth)). AOF + `noeviction` ([R-17](references.md)) | Sweeper heartbeat metric missing for > 2 min → page |
| F-21 | Worker crash mid-batch | Partial processing | Mark-in-transaction + outbox; stalled BullMQ jobs reprocessed after ~30 s ([R-17](references.md)) | Queued outbox age |
| F-22 | Sweeper falls behind (load) | Late alerts → SLO breach | Batched, indexed, `SKIP LOCKED` parallel workers; horizontal scale | Sweeper lag p99 |
| F-23 | Postgres outage | No alerts, no sync | Managed HA; local alarms unaffected; alerts catch up after recovery | Uptime, error rate |
| F-24 | Data loss / corruption | History lost | PITR + quarterly restore drill ([14](14-release-and-ops.md#restore-drill)) | Drill results |
| F-25 | Dose generator bug (DST, every-N-days) | Wrong reminder times | Property tests across timezones and DST ([12](12-testing-and-slos.md#dose-generation-tests)); Phase 2 gate | Canary comparisons |
| F-26 | Duplicate webhook / out-of-order events | Wrong subscription state | Event-ID dedupe + always re-fetch customer ([07](07-subscriptions-and-billing.md#revenuecat-webhooks)) | Reconciliation mismatch rate |
| F-27 | Missed webhooks | Paying users suspended, or lapsed users served | Daily reconciliation; `subscription/refresh` after purchase | Mismatch metric |
| F-28 | Expo Push outage | Backups/alerts delayed | Retry with backoff; outbox keeps `queued`; local alarms unaffected | Ticket error rate, queued age |
| F-29 | FCM deprioritises data pushes | Refill / dose-clear delayed | Treated as best effort ([D-075](01-decisions.md#d-075-data-pushes-are-best-effort)) | Data-push → heartbeat latency |
| F-30 | APNs/FCM credentials expire | All pushes fail | `InvalidCredentials` pages owner; calendar reminder for key expiry | Receipt errors |
| F-31 | Bad deploy | Crashes / broken sync | Staged rollouts, EAS Update rollback, minimum-version gate ([14](14-release-and-ops.md)) | Crash-free rate |

## Security and abuse

| # | Risk | Mitigation |
| --- | --- | --- |
| F-40 | Pairing code brute force | 31⁸ space, 10-min life, 5-attempt lock, rate limits, attestation, spike paging ([06](06-pairing-and-devices.md#abuse-controls)) |
| F-41 | Code intercepted, wrong person pairs | Accepted tradeoff ([D-017](01-decisions.md#d-017-first-redeemer-wins)); instant "connected on" notice with Revoke |
| F-42 | Cross-tenant data access bug | Scoped repositories + isolation tests in CI ([10](10-security-privacy.md#isolation)) |
| F-43 | Health data leaks via logs/Sentry | Scrubbing + deny-list serializer; test that asserts no medicine name appears in captured events |
| F-44 | Photo URL leaked | Short expiry, private bucket, access audited |
| F-45 | DB dump stolen | At-rest encryption; field encryption for names/notes; hashed tokens and codes |
| F-46 | Account sharing / free use via self profile | One login rule; self profile needs a subscription ([D-008](01-decisions.md#d-008-self-profile)) |
| F-47 | Password guessing / credential stuffing | Argon2id, 8-character minimum (D-096), generic errors, per-account and per-IP throttling ([D-095](01-decisions.md#d-095-caregiver-sign-in-is-email--password-in-v1)); login-failure dashboard |
| F-48 | Forgotten password or mistyped email (no verification, no reset in v1) | Accepted risk: no reset in v1 ([D-096](01-decisions.md#d-096-8-character-password-minimum-no-password-reset-in-v1)). Alarms and alerts already on the signed-in phone keep working |

## Store and policy

| # | Risk | Mitigation |
| --- | --- | --- |
| F-50 | Play rejects exact-alarm or battery-exemption use | Use `SCHEDULE_EXACT_ALARM` only; settings-list approach for battery ([D-073](01-decisions.md#d-073-schedule_exact_alarm-only), [D-074](01-decisions.md#d-074-battery-optimisation-via-the-settings-list)) |
| F-51 | Apple rejects for 4.5.4 or 5.1.1(v) | Generic push text; app usable without push; in-app deletion ([D-077](01-decisions.md#d-077-generic-text-in-remote-pushes-app-works-without-notifications), [D-081](01-decisions.md#d-081-in-app-account-deletion)) |
| F-52 | Critical Alerts entitlement refused | Time-sensitive remains the default ([D-027](01-decisions.md#d-027-ios-interruption-levels)) |
| F-53 | DPDP non-compliance by 13 May 2027 | Mapping in [10](10-security-privacy.md#dpdp-mapping); legal review ([C-10](01-decisions.md#c-10-dpdp-act-and-rules--owner--legal-counsel-review-before-phase-5)) |
