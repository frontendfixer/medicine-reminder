# Release and ops

Decisions: [D-062](01-decisions.md#d-062-releases), [D-063](01-decisions.md#d-063-observability), [D-066](01-decisions.md#d-066-security-baseline), [D-069](01-decisions.md#d-069-proposed-slos).

## Environments

| Env | API | DB | EAS channel | Purpose |
| --- | --- | --- | --- | --- |
| `development` | local / dev | dev DB | `development` | Dev builds with `expo-dev-client` |
| `preview` | staging | staging DB (synthetic data only) | `preview` | Internal testers, device matrix |
| `production` | prod | prod DB | `production` | Store builds |

RevenueCat sandbox events are processed only outside production ([07](07-subscriptions-and-billing.md#revenuecat-webhooks)).

## EAS Build and EAS Update

- **Builds:** EAS Build profiles `development`, `preview`, `production`, each mapped to the channel of the same name. Native changes (new module, config plugin, permission, channel version) **require a new build**. They can never ship over the air. Check the current EAS Build docs before Phase 5 ([references](references.md#not-yet-checked-check-before-the-phase-that-needs-it)).
- **Runtime version:** use a runtime-version policy tied to the native fingerprint, so an update never reaches an incompatible binary (verify the current policy options when configuring).
- **Updates:** JS-only fixes ship via EAS Update to the channel's branch.
- **Rollouts** ([R-09](references.md)):
  - Per update: `eas update --rollout-percentage=10`, raise with `eas update:edit`, revert with `eas update:revert-update-rollout`. Only one active rollout per branch, platform and runtime version.
  - Branch-based: `eas channel:rollout` for larger changes.
  - Default plan: 10% → 50% → 100%, at least 24 h between steps, gated on crash-free sessions and sweeper/sync error rates.
- **Store staged rollout:** Play staged rollout percentages and App Store phased release for binaries (check the current console docs in Phase 5).

## Minimum version and app config

- `GET /v1/app/config` returns `min_app_version` per platform, `latest_app_version`, feature flags, support URL and grievance contact ([04](04-api.md#app-config), [D-080](01-decisions.md#d-080-app-config-path-and-forced-update-in-patient-mode)).
- The app checks it on launch and on foreground. Below minimum → blocking "Update required" screen with a store link.
  - **Patient mode exception ([D-080](01-decisions.md#d-080-app-config-path-and-forced-update-in-patient-mode)):** local alarms already scheduled are not cancelled by the update screen. Reminders are the product; the block only prevents sync and edits. The caregiver gets a device problem alert because the app version is below minimum (treated as unhealthy).
- The API also enforces it: `426 UPGRADE_REQUIRED` for requests with `X-App-Version` below minimum, except `app/config`, `devices/heartbeat` and `device/dose-responses`. Answers and heartbeats are always accepted.
- Raise the minimum only when an older version is unsafe (data corruption, wrong reminders, security).

## Monitoring

Dashboards ([D-063](01-decisions.md#d-063-observability)):

| Dashboard | Panels |
| --- | --- |
| **Sweeper** | Lag p50/p99 (SLO < 60 s), rows processed per run, run duration, last successful run timestamp, queued outbox age |
| **Push** | Tickets ok/error by kind, receipts ok/error by error code (`DeviceNotRegistered`, `MessageRateExceeded`, `InvalidCredentials`, `MismatchSenderId`), backup pushes per hour (should be low on healthy fleets), data-push → heartbeat latency |
| **Device health** | % healthy (SLO 98%), by cause (heartbeat > 6 h, permission off by type, window < 24 h, invalid token), by platform, OEM and app version |
| **Alerts** | Missed alerts/hour, alert timeliness distribution (SLO 99.9% < 2 min), Not taken alerts, corrections, device-health alerts |
| **Sync** | Sync and dose-response error rates, outbox delivery latency after network return (SLO 99% < 5 min), `client_event_id` duplicates |
| **Billing** | Webhooks received/processed/deduped, reconciliation mismatches, accounts in `store_grace` / `grace` / `expired`, cutoffs per day |
| **Pairing** | Redeem success/fail, locked codes, rate-limited requests, attestation verdicts |
| **Auth** | Login success/failure, throttled accounts and IPs, registrations per hour |
| **App** | Sentry crash-free sessions (SLO 99.5%) per release, update adoption |

All metrics come from server-side events and are free of health data.

## Alerting

| Alert | Condition | Severity |
| --- | --- | --- |
| Sweeper stalled | No successful sweeper run for 2 min | Page |
| Sweeper lag | p99 > 60 s for 5 min | Page |
| Outbox backlog | Oldest `queued` notification > 2 min | Page |
| Push credentials | Any `InvalidCredentials` / `MismatchSenderId` | Page |
| Push failure rate | Receipt error rate > 5% over 30 min (excluding `DeviceNotRegistered`) | Ticket |
| Pairing failure spike | Global redeem failures above 5× the 7-day baseline ([D-084](01-decisions.md#d-084-pairing-limits-device-limit-and-code-lookup)) | Page ([D-012](01-decisions.md#d-012-pairing-abuse-controls)) |
| Device health | Fleet healthy % < 98% for 6 h | Ticket |
| Webhooks | No RevenueCat webhook for 24 h while purchases occur, or reconciliation mismatches above threshold | Ticket |
| Crash rate | Crash-free < 99.5% on latest release | Ticket; halt rollout |
| DB | Replication lag, storage, connections | Page / ticket |

Thresholds other than SLO numbers are suggestions to tune in Phase 4.

## Incident steps

1. **Detect & declare:** the on-call acknowledges the page and opens an incident note (time, symptom, dashboards).
2. **Protect reminders first:** confirm local alarms are unaffected (they are phone-side). Check whether missed alerts are delayed (sweeper/outbox) and say so in the caregiver-facing status note if more than 15 minutes.
3. **Mitigate:**
   - Bad app update → `eas update:revert-update-rollout` or roll back to the embedded update; halt store rollout.
   - Bad API deploy → roll back the container image.
   - Redis lost → restart Redis; workers re-upsert Job Schedulers; sweeper catches up ([F-20](11-failure-modes.md#server)).
   - Push credentials → rotate via `eas credentials` / FCM key re-upload ([R-08](references.md)).
4. **Verify catch-up:** sweeper lag back under 60 s; outbox drained; no duplicate alerts (check `notification_log` per dose).
5. **Personal data breach?** If personal data's confidentiality, integrity or availability was compromised: notify affected users without delay. Notify the Data Protection Board without delay, with the detailed report **within 72 hours** (DPDP Rule 7, [R-44](references.md)). Involve the grievance contact and counsel.
6. **Postmortem** within 5 working days: timeline, impact (doses/alerts affected), root cause, action items. Link it from the decision log if a decision changes.

## Restore drill

- **Postgres PITR** enabled with the managed provider; retention ≥ 7 days (suggestion; align with the DPDP 1-year log rule through separate log archiving, [10](10-security-privacy.md#dpdp-mapping)).
- **Drill** before launch (Phase 5 gate prerequisite) and **quarterly**:
  1. Restore to a new instance at a chosen timestamp.
  2. Run migrations check and row-count / checksum comparison on key tables (`dose_instances`, `devices`, `subscriptions`).
  3. Point a staging API at it; run the reminder-engine integration suite and a sweeper pass.
  4. Record duration (RTO) and data loss window (RPO) in this doc.
- R2: the bucket has object versioning or a replicated copy for photos (check current R2 features in Phase 5).
- Redis is **not** backed up beyond AOF: it holds no state we can't rebuild.

> Last drill: _not run_

## Routine operations

| Task | Cadence |
| --- | --- |
| Review SLO error budgets | Weekly from Phase 4 |
| Re-check references and versions | Quarterly, and before each phase |
| Rotate secrets (JWT keys, peppers via versioned keys, RevenueCat/Expo tokens) | Per policy; on any suspected leak |
| APNs / FCM credential expiry check | Monthly |
| Restore drill | Quarterly |
| Audit-log and notification-log retention job | Daily (keep ≥ 1 year, [C-10](01-decisions.md#c-10-dpdp-act-and-rules--owner--legal-counsel-review-before-phase-5)) |
