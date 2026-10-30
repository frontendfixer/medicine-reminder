# API

NestJS REST API under `/v1` ([D-058](01-decisions.md#d-058-api-stack)). JSON over HTTPS only. Field names in `snake_case`, matching [03-data-model](03-data-model.md).

## Conventions

### Auth
| Scheme | Header | Who |
| --- | --- | --- |
| `caregiver` | `Authorization: Bearer <access JWT>` | Signed-in caregiver. Short-lived access token (suggest 15 min) + rotating refresh token bound to the single active session (D-019) |
| `device` | `Authorization: Device <device token>` | Paired patient device (including the self-profile device). Server looks up `devices.token_hash = HMAC(token)` where `revoked_at is null` |
| `none` | — | Only `auth/register`, `auth/login`, `auth/refresh`, `pairing/challenge`, `pairing/redeem`, `app/config` |
| `webhook` | RevenueCat authorization header (+ HMAC signature if enabled) | `webhooks/revenuecat` |

All `device` endpoints are scoped to the token's `patient_id`. All `caregiver` endpoints that take `{patientId}` require `patients.owner_user_id = caller` ([10](10-security-privacy.md#isolation)).

### Idempotency
- Every `POST`, `PATCH` and `DELETE` accepts `Idempotency-Key: <uuid>`. It is required on all writes except `auth/*` and the webhook.
- The server stores (`principal`, `key`) → request hash + response. It replays the stored response for an identical retry. A different body with the same key gets `409 IDEMPOTENCY_KEY_REUSED`. Records are kept for 24 hours per principal ([D-083](01-decisions.md#d-083-sign-out-endpoint-and-idempotency-retention)).
- `POST /v1/device/dose-responses` is additionally idempotent per item by `client_event_id`.
- **How it works** (`apps/api/src/idempotency/`):
  - The key is a UUID; a missing or malformed key is `400 VALIDATION_FAILED`. The server claims `(principal, key)` atomically before running the handler, so concurrent identical requests run it once.
  - The request hash is an HMAC of method, path, query and the body with sorted keys, so reordered JSON counts as the same request. Same key with a different hash, method or path is `409 IDEMPOTENCY_KEY_REUSED`.
  - A retry that arrives while the first is still running gets `409 REQUEST_IN_PROGRESS` with `Retry-After: 1`. A claim with no result after 60 s is treated as abandoned and can be taken over.
  - Stored: `2xx` responses and expected `4xx` errors, replayed with the same status and body plus `Idempotent-Replayed: true`. Not stored: `5xx`, `408`, `425`, `429` and unexpected errors; the key is released so the retry runs again.
  - Stored responses are encrypted (they can contain medicine names).
  - A write without a caller (no principal) fails closed with `500`; such routes must be marked exempt on purpose (see OI-30).

### Errors
```json
{ "error": { "code": "PATIENT_LIMIT_REACHED", "message": "Your plan allows 3 patients.", "details": {} } }
```

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | Body/query invalid (`details.fields`) |
| 401 | `UNAUTHENTICATED` | Missing or invalid JWT |
| 401 | `INVALID_CREDENTIALS` | Wrong email or password (generic; no hint which) |
| 409 | `EMAIL_TAKEN` | Registration with an email that already has an account |
| 401 | `SESSION_REPLACED` | Caregiver signed in on another phone (D-019); app shows the notice |
| 401 | `DEVICE_TOKEN_REJECTED` | Device revoked or unknown; patient app shows "Ask your caregiver for a new code" (D-015) |
| 403 | `FORBIDDEN` | Not owner / out of scope |
| 403 | `SUBSCRIPTION_INACTIVE` | No active subscription (D-054); for the self profile too |
| 403 | `PATIENT_SUSPENDED` | Write to a suspended patient (D-056) |
| 404 | `NOT_FOUND` | Also returned for resources outside caller scope (no existence leak) |
| 409 | `PATIENT_LIMIT_REACHED` | Quota (D-053) |
| 409 | `DEVICE_LIMIT_REACHED` | 3 active devices (D-018, [D-084](01-decisions.md#d-084-pairing-limits-device-limit-and-code-lookup)) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | See above |
| 409 | `REQUEST_IN_PROGRESS` | Same key, first request still running (`Retry-After: 1`) |
| 410 | `CODE_EXPIRED_OR_USED` | Pairing/transfer code expired, used, superseded or locked |
| 422 | `CODE_INVALID` | Wrong code (counts toward lock and rate limit) |
| 426 | `UPGRADE_REQUIRED` | App below minimum version (`X-App-Version` header) |
| 429 | `RATE_LIMITED` | `Retry-After` header set |
| 500 | `INTERNAL` | Unexpected error. Generic message; details only in server logs, which never hold request bodies |

Plain framework errors (unknown route, malformed JSON) use the same format with generic messages. Codes and statuses live in `@med/shared` (`ERROR_STATUS`).

Every request from the app sends `X-App-Version` and `X-Platform`.

### Pagination
Cursor-based: `?cursor=<opaque>&limit=<1..100>` → `{ "items": [...], "next_cursor": "..." | null }`.

---

## Auth

| Method & path | Auth | Request | Response |
| --- | --- | --- | --- |
| `POST /v1/auth/register` | none | `{ email, password, device: DeviceInfo, consent: { notice_version } }` | `201 AuthResult`. No email verification. `409 EMAIL_TAKEN` if the email exists (accepted risk). `400 VALIDATION_FAILED` if the password is not 8–128 characters ([D-096](01-decisions.md#d-096-8-character-password-minimum-no-password-reset-in-v1)) |
| `POST /v1/auth/login` | none | `{ email, password, device: DeviceInfo }` | `200 AuthResult`. Any failure → `401 INVALID_CREDENTIALS`, same status and timing whether or not the email exists. Throttled per account and per IP (`429 RATE_LIMITED`) |
| `POST /v1/auth/refresh` | none (refresh token in body) | `{ refresh_token }` | `200 { access_token, refresh_token }`. `401 SESSION_REPLACED` if the session was superseded |
| `POST /v1/auth/logout` | caregiver | — | `204`. Revokes the session and the caregiver device row; the self-profile device on this phone is revoked too and its alarms cancelled ([D-083](01-decisions.md#d-083-sign-out-endpoint-and-idempotency-retention)) |

`DeviceInfo = { platform, app_version, label?, push_token?, tz? }`

**Implementation** (`apps/api/src/auth/`):
- **Access token:** HS256 JWT, 15 minutes, claims `sub` (user), `sid` (session), issuer and audience checked. The guard also loads the session on every request, so a replaced or signed-out phone is refused at once: `SESSION_REPLACED` if another phone took over, `UNAUTHENTICATED` after logout. Every route is deny-by-default unless marked `@Public()`.
- **Refresh token:** 32 random bytes, only an HMAC is stored, rotated on every use (the old one stops working). A session unused for 90 days expires. Refreshing a replaced session gives `SESSION_REPLACED`.
- **Passwords:** NFKC-normalised, then Argon2id (m = 19 MiB, t = 2, p = 1) with the pepper as Argon2's secret input. 8–128 characters counted as Unicode code points. An unknown email runs the same Argon2 check against a dummy hash.
- **Throttling** (Redis, so losing it only resets counters). These numbers are suggestions, not decisions:
  - **Per account:** keyed by the email address, so unknown emails behave identically. Every attempt is counted atomically. The first 5 are free, then the delay is 30 s, doubling to a 15 minute cap; a delay blocks even the right password. A successful sign-in resets it; the count is forgotten after an hour without attempts.
  - **Per IP:** 30 sign-in attempts per 10 minutes, 10 registrations per hour. Behind a proxy the app must set `trust proxy` so `req.ip` is the client.
- **Not built yet:** the push to the old phone ("Signed in on another phone", Phase 3 push sender) and `self_profile_device_token` (self-profile item). `session_replaced_previous` is returned already.

Emails are trimmed and lower-cased. Passwords are never logged or echoed.

`AuthResult = { access_token, refresh_token, user: { id, email }, session_replaced_previous: boolean, self_profile_device_token?: string }`

v1 sign-in is email + password only ([D-095](01-decisions.md#d-095-caregiver-sign-in-is-email--password-in-v1)). Email OTP, Google and Apple sign-in, and email verification, arrive in v1.1. There is no password reset or password change in v1 ([D-096](01-decisions.md#d-096-8-character-password-minimum-no-password-reset-in-v1)).

A successful sign-in revokes any previous active session and caregiver device row. It sends the old phone a push ("Signed in on another phone"), and moves the self-profile device to the new phone ([06](06-pairing-and-devices.md#caregiver-login)).

## Patients

| Method & path | Auth | Request | Response / notes |
| --- | --- | --- | --- |
| `POST /v1/patients` | caregiver | `{ display_name, type: "managed"\|"self", timezone, tz_mode, missed_delay_min? }` | `201 Patient`. Managed: quota check (D-053). Self: one per caregiver, needs active subscription |
| `GET /v1/patients` | caregiver | `?status=` | `200 { items: Patient[] }` with device-health summary |
| `GET /v1/patients/{patientId}` | caregiver | — | `200 Patient` |
| `PATCH /v1/patients/{patientId}` | caregiver | any of `display_name, timezone, tz_mode, missed_delay_min, lockscreen_detail` | `200 Patient`. Timezone change regenerates future doses (D-040). Delay change affects future doses only (D-048) |
| `POST /v1/patients/{patientId}/archive` | caregiver | — | `200 Patient`. Revokes devices, deletes future pending doses |
| `POST /v1/patients/{patientId}/reactivate` | caregiver | — | `200 Patient`. Quota check (D-053) |

`Patient = { id, display_name, type, timezone, tz_mode, missed_delay_min, lockscreen_detail, status, devices: DeviceSummary[], created_at }`

## Pairing

| Method & path | Auth | Request | Response / notes |
| --- | --- | --- | --- |
| `POST /v1/patients/{patientId}/pairing-code` | caregiver | — | `201 { code: "XXXX-XXXX", qr_payload, expires_at }`. Invalidates the previous `pair` code for this patient (D-011) |
| `POST /v1/pairing/challenge` | none | `{ platform }` | `200 { challenge, expires_at }` for App Attest / Play Integrity `requestHash` (D-013, recommended) |
| `POST /v1/pairing/redeem` | none | `{ code, device: DeviceInfo, attestation?: { platform, token \| key_id + attestation_object, challenge }, consent: { notice_version } }` | `201 { device_id, device_token, patient: { id, display_name, timezone } }`. Errors: `CODE_INVALID`, `CODE_EXPIRED_OR_USED`, `DEVICE_LIMIT_REACHED`, `RATE_LIMITED` |

Full rules: [06-pairing-and-devices](06-pairing-and-devices.md#pairing).

## Devices

| Method & path | Auth | Request | Response / notes |
| --- | --- | --- | --- |
| `GET /v1/patients/{patientId}/devices` | caregiver | — | `200 { items: DeviceSummary[] }` |
| `POST /v1/devices/{deviceId}/revoke` | caregiver | — | `200 DeviceSummary`. Audited. Device gets `DEVICE_TOKEN_REJECTED` on its next call |
| `POST /v1/devices/heartbeat` | caregiver or device | `Heartbeat` | `200 { server_time, sync_needed: boolean, min_app_version }` |

`DeviceSummary = { id, platform, label, app_version, last_seen_at, scheduled_through, permissions: {...}, healthy: boolean, problems: string[], created_at, revoked_at }`

`Heartbeat = { push_token?, permissions: { notifications, exact_alarm?, battery_unrestricted?, time_sensitive? }, app_version, tz, scheduled_through }` ([D-041](01-decisions.md#d-041-heartbeat))

## Medicines

| Method & path | Auth | Request | Response / notes |
| --- | --- | --- | --- |
| `GET /v1/patients/{patientId}/medicines` | caregiver | `?include_archived=` | `200 { items: Medicine[] }` |
| `POST /v1/patients/{patientId}/medicines` | caregiver | `MedicineInput` | `201 Medicine`. Creates schedule version 1 and generates doses |
| `GET /v1/medicines/{medicineId}` | caregiver | — | `200 Medicine` (with current schedule) |
| `PATCH /v1/medicines/{medicineId}` | caregiver | partial `MedicineInput` | `200 Medicine`. Closes the current schedule version, opens a new one effective now, regenerates future pending doses (D-023, D-034) |
| `POST /v1/medicines/{medicineId}/archive` | caregiver | — | `200 Medicine`. Deletes future pending doses |
| `PATCH /v1/medicines/{medicineId}/stock` | caregiver | `{ stock_count, low_stock_at }` | v1.1 (D-070). Returns `404` in v1 behind a feature flag |

```jsonc
// MedicineInput
{
  "name": "Metformin 500",
  "notes": "After food",
  "photo_object_key": "u/…/m/….jpg",     // from uploads/presign, or null to remove
  "notification_type": "alarm",            // standard | alarm | gentle
  "missed_delay_min": 45,                  // optional
  "schedule": {
    "pattern": "weekdays",                 // daily | weekdays | every_n_days
    "days_of_week": [1, 3, 5],             // weekdays only
    "interval_days": null,                 // every_n_days only
    "start_date": "2026-11-01",
    "end_date": null,
    "times": [ { "local_time": "08:00", "amount_text": "1 tablet" },
               { "local_time": "21:00", "amount_text": "2 tablets" } ]
  }
}
```

## Uploads

| Method & path | Auth | Request | Response / notes |
| --- | --- | --- | --- |
| `POST /v1/uploads/presign` | caregiver | `{ patient_id, content_type: "image/jpeg", byte_size }` | `200 { object_key, upload_url, headers, expires_at }`. `PUT` to R2 with the signed `Content-Type`. The server verifies size and type with `HEAD` when the key is attached to a medicine ([10](10-security-privacy.md#photos)) |

## Device sync and answers

| Method & path | Auth | Request | Response / notes |
| --- | --- | --- | --- |
| `GET /v1/device/sync` | device | `?cursor=` | `200 SyncResult` |
| `POST /v1/device/dose-responses` | device | `{ responses: DoseResponse[] }` (≤ 100) | `200 { results: [{ client_event_id, outcome: "applied"\|"duplicate"\|"superseded"\|"rejected", dose: DoseState }] }` |

```jsonc
// SyncResult
{
  "cursor": "opaque",
  "patient": { "id": "…", "display_name": "…", "timezone": "Asia/Kolkata",
               "status": "active", "lockscreen_detail": "full" },
  "account_state": "active",          // active | grace | suspended  → banners (07)
  "medicines": [ { "id": "…", "name": "…", "notes": "…", "notification_type": "alarm",
                   "photo": { "url": "https://…r2.cloudflarestorage.com/…", "expires_at": "…", "etag": "…" } } ],
  "doses": [ { "id": "…", "medicine_id": "…", "scheduled_at": "…Z", "local_time": "08:00",
               "name": "…", "amount": "1 tablet", "status": "pending", "snooze_until": null,
               "alert_due_at": "…Z", "notification_type": "alarm" } ],
  "window": { "from": "…Z", "through": "…Z" },   // server-issued window (05)
  "commands": [ "cancel_all" ]                     // e.g. at cutoff (07)
}
```

The device replaces its whole scheduled set with the issued window: it cancels any local notification whose dose ID is absent and schedules missing ones ([05](05-reminder-engine.md#device-scheduling)).

```jsonc
// DoseResponse
{ "client_event_id": "uuid", "dose_id": "uuid", "action": "taken",  // taken | not_taken | snooze
  "responded_at": "2026-11-01T02:31:10Z",
  "network_restored_at": null }   // set when the answer was queued offline; used for the offline-delivery SLO (12)
```

Rules: [05-reminder-engine](05-reminder-engine.md#answers-and-sync).

## History and adherence

| Method & path | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /v1/patients/{patientId}/doses` | caregiver | `?from=&to=&status=&medicine_id=&cursor=` | `200 { items: Dose[], next_cursor }` (works for suspended patients, read-only) |
| `GET /v1/patients/{patientId}/adherence` | caregiver | `?from=&to=&group_by=day\|medicine` | `200 { buckets: [{ key, taken, not_taken, missed, pending }] }` |
| `GET /v1/patients/{patientId}/audit-log` | caregiver | `?cursor=` | `200 { items: AuditEntry[], next_cursor }` (D-066) |

## Transfer

| Method & path | Auth | Request | Response / notes |
| --- | --- | --- | --- |
| `POST /v1/patients/{patientId}/transfer-code` | caregiver (owner) | — | `201 { code, qr_payload, expires_at }`. Same format and lifetime as pairing codes, kind `transfer` |
| `POST /v1/transfers/redeem` | caregiver (receiver) | `{ code, as_self: boolean }` | `200 Patient`. Quota check for `managed`. `as_self: true` makes it the receiver's self profile (D-050). Both sides audited |

## Settings

| Method & path | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /v1/settings` | caregiver | — | `200 { default_missed_delay_min, lockscreen_detail, daily_summary }` |
| `PATCH /v1/settings` | caregiver | any of the above | `200 Settings`. Delay change affects future doses only |

## Subscription

| Method & path | Auth | Request | Response / notes |
| --- | --- | --- | --- |
| `GET /v1/subscription` | caregiver | — | `200 { plan, patient_limit, managed_patients, status, renews_at, expired_at, cutoff_at }`. With no subscription: `plan: null`, `status: null`, `patient_limit: 0` (the app shows the paywall). `managed_patients` counts active managed patients only |
| `POST /v1/subscription/refresh` | caregiver | — | `200 Subscription`. Re-fetches from RevenueCat after a purchase or restore |
| `POST /v1/webhooks/revenuecat` | webhook | RevenueCat event | `200` fast; processed async, deduped by event `id` ([07](07-subscriptions-and-billing.md#revenuecat-webhooks)) |

## Privacy

| Method & path | Auth | Request | Response / notes |
| --- | --- | --- | --- |
| `POST /v1/me/export` | caregiver | — | `202 { request_id }`. The export is delivered in-app as a short-lived download link (D-067) |
| `POST /v1/me/delete` | caregiver | `{ confirm: "DELETE", password }` | `202`. In-app account deletion ([D-081](01-decisions.md#d-081-in-app-account-deletion)); retention per [C-10](01-decisions.md#c-10-dpdp-act-and-rules--owner--legal-counsel-review-before-phase-5) |

## App config

| Method & path | Auth | Response |
| --- | --- | --- |
| `GET /v1/app/config` | none | `200 { min_app_version: { ios, android }, latest_app_version, feature_flags: {...}, support_url, grievance_contact }` |

This contract must never break, because it's how old builds learn they must update ([D-080](01-decisions.md#d-080-app-config-path-and-forced-update-in-patient-mode), [14](14-release-and-ops.md#minimum-version-and-app-config)).
