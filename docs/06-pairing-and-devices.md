# Pairing and devices

Covers pairing codes, transfer codes, patient device tokens, device limits, the single caregiver login, revoke and recovery. Decisions: [D-010](01-decisions.md#d-010-pairing-code-format)–[D-019](01-decisions.md#d-019-one-caregiver-login), [D-049](01-decisions.md#d-049-transfer), [D-050](01-decisions.md#d-050-patient-becomes-caregiver).

## Code format (pairing and transfer)

| Property | Value |
| --- | --- |
| Length | 8 symbols, shown `XXXX-XXXX` |
| Alphabet | 31 symbols, no look-alikes: `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (digits 2–9, letters without I, L, O) |
| Entropy | 31⁸ ≈ 8.5 × 10¹¹ |
| Generation | CSPRNG, rejection sampling (no modulo bias) |
| Normalisation on input | Uppercase, strip `-` and spaces. `0→O` and `1→I/L` are **not** auto-mapped; those symbols are invalid |
| QR payload | `medremind://pair?c=XXXXXXXX` (or `transfer`), scanned with `expo-camera` |
| Lifetime | **10 minutes**, single use |
| Supersede | A new code invalidates the previous live code of the same kind for that patient |
| Storage | Only `code_hash = HMAC-SHA256(server pepper, normalised code)`. The pepper lives in the secret manager, not the DB |
| Lock | **5 failed attempts** lock the code ([Code lookup and lock](#code-lookup-and-lock)) |

## Pairing

### Caregiver side
1. `POST /v1/patients/{patientId}/pairing-code` → code + QR + `expires_at`. Requires an active subscription and an `active` patient.
2. The app shows the code with a 10-minute countdown and "Hand this over in person or in a trusted chat. Whoever enters it first becomes [patient]" ([D-017](01-decisions.md#d-017-first-redeemer-wins)).
3. The app polls (or receives a `pairing` push) and shows **"Patient connected on [device label, time]"** with **Revoke** and **Re-pair** ([D-016](01-decisions.md#d-016-pairing-confirmation)).

### Patient side
1. Choose *I take medicines*, read the privacy notice and give consent (recorded with the notice version, [10](10-security-privacy.md#consent)).
2. Scan the QR or type the code.
3. Optional attestation ([D-013](01-decisions.md#d-013-device-attestation-on-redeem), recommended): `POST /v1/pairing/challenge` → challenge. Android: Play Integrity standard request with `requestHash = SHA256(challenge ‖ code_hash_prefix)`. iOS: App Attest `attestKey(keyId, SHA256(challenge))`. Uses `@expo/app-integrity` ([R-06](references.md)). On iOS the key is stored for later assertions.
4. `POST /v1/pairing/redeem`.
5. Store `device_token` in `expo-secure-store` with `keychainAccessible: AFTER_FIRST_UNLOCK`, so the background task can read it after reboot + first unlock ([R-04](references.md)).
6. Go to guided permission setup ([08](08-notifications-and-platform.md#permission-onboarding)), then sync.

### Server redeem transaction
```
rate-limit check (IP, device install id, global)           → 429 RATE_LIMITED
verify attestation if provided; record verdict             (policy: log-only first, enforce later — R-35)
BEGIN
  find live code by lookup_hash, FOR UPDATE                → 422 CODE_INVALID if none (counts toward rate limits)
  if expired / used / invalidated / failed_attempts ≥ 5    → 410 CODE_EXPIRED_OR_USED
  if code_hash mismatch: failed_attempts += 1; COMMIT      → 422 CODE_INVALID
  lock patient row; require status = 'active' and owner subscription active
  count active devices for patient; if ≥ 3                 → 409 DEVICE_LIMIT_REACHED (D-084)
  mark code used_at = now()
  generate device_token (256-bit random, base64url); store token_hash = HMAC(pepper, token)
  insert devices row (patient_id, platform, label, app_version, tz)
  insert consents row (patient, pairing, notice_version)
  insert audit_log (pairing.redeemed)
COMMIT
enqueue notification to caregiver: "Patient connected on …"
```

### Abuse controls
([D-012](01-decisions.md#d-012-pairing-abuse-controls))
- Per-IP, per-device-install and global limits on `pairing/redeem` (10 per minute per IP, 5 per device install per 10 minutes; [D-084](01-decisions.md#d-084-pairing-limits-device-limit-and-code-lookup)). Implemented with `@nestjs/throttler` backed by Redis. If Redis is down, **fail closed** for redeem only: pairing is rare, and reminders don't depend on it.
- Global failure-rate metric. Above 5× the 7-day baseline it pages the owner ([14](14-release-and-ops.md#alerting)).
- Codes are useless after 10 minutes, a single use, or 5 failures.

## Device tokens

| Property | Rule |
| --- | --- |
| Format | 256-bit random, base64url, opaque |
| Storage on phone | `expo-secure-store` (Keychain / Android Keystore-encrypted prefs), excluded from Android Auto Backup by the config plugin ([R-04](references.md)) |
| Storage on server | `devices.token_hash` (HMAC-SHA256 with pepper); unique |
| Scope | Exactly one patient |
| Lifetime | Long-lived; no expiry. Ends on revoke, re-pair, patient archive or account deletion. Transfer keeps it ([Transfer](#transfer)) |
| Rotation | Re-pair issues a new token and revokes the old device row |
| Use | `Authorization: Device <token>` on `device/*` and `devices/heartbeat` |

### Rejected token
([D-015](01-decisions.md#d-015-rejected-token))
- Any `401 DEVICE_TOKEN_REJECTED` → the patient app shows one screen, **"Ask your caregiver for a new code"**, with a field to enter a new code.
- **Local alarms already scheduled keep firing.** The app does not cancel them. Answers keep queueing locally and are dropped only after a successful re-pair to a *different* patient.
- The server alerts the caregiver (kind `pairing`, [D-082](01-decisions.md#d-082-schema-additions)) the first time a revoked or unknown token is presented for a known device row. Throttled to once per 12 h per device.

## Device limits

| Principal | Limit | Enforcement |
| --- | --- | --- |
| Patient | **Up to 3 active devices**, each paired with its own code ([D-018](01-decisions.md#d-018-up-to-3-patient-devices)) | Count under patient row lock in redeem. A 4th redeem is refused ([D-084](01-decisions.md#d-084-pairing-limits-device-limit-and-code-lookup)) |
| Caregiver | **One active login** ([D-019](01-decisions.md#d-019-one-caregiver-login)) | Partial unique index on `devices(user_id) where revoked_at is null` + `auth_sessions` |

An answer on one patient device sends a data push that clears that dose on the others. This is best effort ([D-075](01-decisions.md#d-075-data-pushes-are-best-effort)); the next sync always converges.

## Caregiver login

- Sign-in on a new phone, in one transaction: revoke the previous `auth_sessions` row and caregiver `devices` row, create new ones. Then push "You were signed in on another phone" to the old device. The old phone's next API call gets `401 SESSION_REPLACED` and shows the notice. **No limit on device switches.**
- **Self profile follows the login.** The self profile's device row (a patient-type device with its own token) is revoked on the old phone and a new one is issued with the sign-in response (`self_profile_device_token`). The old phone cancels its self-profile alarms when it learns it was signed out. Until then, alarms already scheduled may still fire there, which is harmless.
- A caregiver who is also a paired patient on the same phone keeps the patient profile; it's a separate device token.

## Revoke and re-pair

- **Revoke** (`POST /v1/devices/{deviceId}/revoke`): sets `revoked_at`, audits `device.revoked`, sends a best-effort `cancel_all` data push. The device's next call gets `DEVICE_TOKEN_REJECTED`. Its local alarms keep firing until it syncs or the user re-pairs (D-015). The caregiver sees this in the UI.
- **Re-pair**: generate a new code for the same patient. On redeem from a device install that already has a row for this patient, the old row is revoked and the token rotated ([D-014](01-decisions.md#d-014-patient-device-token)).

## Recovery

| Situation | What happens |
| --- | --- |
| Patient reinstalls app / new phone | Secure store is gone (Android) or not guaranteed (iOS, [R-04](references.md)). Old device row goes stale → device problem alert after 6 h. Caregiver generates a new code; old row can be revoked |
| Patient phone lost | Caregiver revokes the device. Remaining devices continue |
| Code expired before use | Generate again (invalidates nothing else) |
| Wrong person redeemed | Caregiver sees "Patient connected on …", taps **Revoke**, then **Re-pair** |
| Caregiver phone lost | Sign in on a new phone; the old session is revoked automatically |

## Transfer

([D-049](01-decisions.md#d-049-transfer))
1. Owner: `POST /v1/patients/{patientId}/transfer-code` → code (kind `transfer`, same format, 10 min, single use, 5 failures lock).
2. Receiver (signed-in caregiver with an active subscription): `POST /v1/transfers/redeem { code, as_self }`.
3. Transaction: lock the receiver's `subscriptions` row. If `as_self = false`, check quota (D-053) → `409 PATIENT_LIMIT_REACHED`. If `as_self = true`, require no existing self profile ([D-092](01-decisions.md#d-092-one-self-profile-per-caregiver)). Set `owner_user_id = receiver`, and `type = 'self'` if `as_self`. Audit `transfer.redeemed` for both users (the old owner's view keeps the entry).
4. **Moves intact:** medicines, schedule versions, full dose history, pairing and all patient devices (device tokens unchanged).
5. The old caregiver loses access immediately. Missed-dose alerts go to the new owner from the next sweep.
6. Patient-level settings stay. Caregiver-level defaults (`default_missed_delay_min`, `lockscreen_detail`) now come from the new owner for **future** doses only (frozen `alert_due_at`).

### Patient becomes caregiver
([D-050](01-decisions.md#d-050-patient-becomes-caregiver)) Subscribing inside the patient app creates a separate caregiver account on the same phone (sign-in required). The patient profile stays with its current owner. To self-manage, the owner generates a transfer code and the new caregiver redeems it with `as_self = true`, making it their self profile. The existing patient device on that phone stays paired. The new account follows the one-login rule.

## Code lookup and lock

([D-084](01-decisions.md#d-084-pairing-limits-device-limit-and-code-lookup)) A wrong 8-symbol guess identifies no code, so the first 4 symbols act as a lookup ID (`lookup_hash` = HMAC of the first 4) and the full 8 are verified against `code_hash`. A wrong full code whose first half matches a live code counts as a failed attempt on that code; at 5 it's locked. Random guessing still faces the full 31⁸ space plus rate limits. Generation retries if the new code's first half collides with another live code.
