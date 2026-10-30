# Security and privacy

Decisions: [D-066](01-decisions.md#d-066-security-baseline), [D-067](01-decisions.md#d-067-dpdp-and-store-compliance). Legal review items: [C-10](01-decisions.md#c-10-dpdp-act-and-rules--owner--legal-counsel-review-before-phase-5), [D-081](01-decisions.md#d-081-in-app-account-deletion).

## Data classification

| Class | Examples | Handling |
| --- | --- | --- |
| Health-related personal data | Medicine names, notes, photos, dose history, patient name | Field encryption (names, notes, display name, name snapshots); private bucket; never in logs, Sentry or analytics |
| Account data | Email (unverified in v1), push tokens | DB encryption at rest; push tokens never logged in full |
| Credentials | Passwords, device tokens, refresh tokens, pairing/transfer codes | Passwords: Argon2id + pepper. Others: only HMAC hashes server-side. Secure store on phone |
| Operational | Heartbeats, permission states, app versions | Normal |

## Controls

| Control | Implementation |
| --- | --- |
| TLS everywhere | HTTPS only (HSTS); R2 via HTTPS presigned URLs; DB and Redis connections over TLS |
| Encryption at rest | Managed Postgres storage encryption; R2 encrypts at rest; encrypted backups |
| Field-level encryption | See below |
| Point-in-time recovery | Managed PITR with a **tested restore** each quarter and before launch ([14](14-release-and-ops.md#restore-drill)) |
| Isolation | See below |
| Audit log | See below |
| Secrets | Secret manager for: JWT signing keys, HMAC pepper, password pepper, field-encryption keys, R2 keys, RevenueCat secret + webhook auth, Expo access token. Rotatable |
| Auth hardening | Email + password ([D-095](01-decisions.md#d-095-caregiver-sign-in-is-email--password-in-v1)): Argon2id (m = 19 MiB, t = 2, p = 1) with a pepper ([R-47](references.md)); 8–128 characters ([D-096](01-decisions.md#d-096-8-character-password-minimum-no-password-reset-in-v1); shorter than OWASP's 15 for non-MFA accounts), no composition rules, no truncation ([R-48](references.md)); no password reset, change or breach check in v1; generic login errors with constant timing; per-account progressive throttling + per-IP limits, no hard lockout; password re-entry for account deletion. Short-lived access JWTs; rotating refresh tokens bound to one session. Passwords never logged (Sentry deny-list includes `password`). **Pepper risk:** `PASSWORD_PEPPER` is not stored with the hashes, and v1 has no reset, so losing it locks every caregiver out for good. Keep it in the secret manager with a backup; changing it requires re-hashing at login (not built) |
| Abuse | Pairing limits and attestation ([06](06-pairing-and-devices.md#abuse-controls)); per-principal rate limits on all writes |
| Push security | Expo Push access token ("enhanced security") enabled ([D-090](01-decisions.md#d-090-expo-push-access-token)) |
| Dependencies | Lockfiles, automated advisories, versions re-checked per [CLAUDE.md](../CLAUDE.md) |
| On-device | Device token and refresh token in `expo-secure-store`. SQLite holds cached medicine data; consider SQLCipher (`useSQLCipher`, [R-05](references.md)) (suggestion, not decided) |

### Field-level encryption
- Encrypted columns: `medicines.name`, `medicines.notes`, `dose_instances.name_snapshot`, `patients.display_name` (D-082), and `idempotency_keys.response_body` (cached responses can contain medicine names).
- AES-256-GCM with a per-row random nonce. A data key (DEK) is wrapped by a key in the cloud KMS / secret manager. The key ID is stored with the ciphertext (`v1:<kid>:<nonce>:<ct>`) to allow rotation.
- Implementation (`apps/api/src/crypto/field-encryption.ts`):
  - 96-bit random IV per value and a 128-bit tag ([R-63](references.md)). A key can encrypt about 2³² values before it must be retired (NIST SP 800-38D 8.3), which rotation covers at this scale.
  - The AAD is `v1:<kid>:<table.column>`, so a ciphertext copied to another column, or with an edited key ID, fails to decrypt. Because the snapshot is a separate column, `dose_instances.name_snapshot` is decrypted from `medicines.name` and re-encrypted under its own field.
  - Stored in the `bytea` column as the UTF-8 bytes of `v1:<kid>:<iv>:<ciphertext‖tag>` (base64url parts).
  - Keys come from the secret manager as `FIELD_ENCRYPTION_KEYS=kid:base64,…` with `FIELD_ENCRYPTION_ACTIVE_KID`. Old key IDs stay in the set while any value still uses them; `isCurrent()` finds values to re-encrypt. Wrapping the keys with a cloud KMS is not done yet, because the hosting provider is not chosen.
  - Errors never contain plaintext, keys or ciphertext.
- Decryption happens only in the API process, just before serialising responses to an authorised principal.
- Consequence: no SQL search or sort on these fields. Sorting by name happens in the app.

### Isolation
- Every caregiver query is scoped by `patients.owner_user_id = :callerId`. Every device query is scoped by the token's `patient_id`. Enforced in a repository layer that requires a scope argument; no unscoped repository methods.
- Out-of-scope resources return `404`, not `403`. Implemented for patients in `PatientsRepository` (`apps/api/src/patients/`): the owner is a required argument of every method, and the same `404` covers "not yours", "doesn't exist" and "not a UUID".
- **Automated isolation tests** ([12](12-testing-and-slos.md#isolation-tests)): for every endpoint, caller A must get `404` for B's patient, medicine, dose, device, photo, audit log and pairing code. This runs in CI against a seeded two-tenant DB.
- Optional defence in depth: Postgres row-level security keyed on a session variable (suggestion).

### Photos
([D-024](01-decisions.md#d-024-photos), [R-19](references.md))
- Private R2 bucket, no public access, no custom domain (presigned URLs work only on the S3 API domain).
- Upload: the phone resizes and re-encodes (removing EXIF) with `expo-image-manipulator` (verify EXIF removal in Phase 2). It then requests `POST /v1/uploads/presign`, and `PUT`s with the signed `Content-Type` (presigned `POST` forms are not supported). The URL expires in minutes.
- Size cap: **1 MB** after compression, longest edge **1280 px** ([D-091](01-decisions.md#d-091-photo-size-cap)). The presign request declares `byte_size`. When the key is attached to a medicine, the server `HEAD`s the object, rejects and deletes it if it's too large or the wrong type, and checks for EXIF markers.
- Read: short-lived presigned `GET` URLs (suggest 15 minutes) issued only to the patient's owner and the patient's paired devices, in sync responses. Every issuance is audited (`photo.read_url_issued`). Presigned URLs are bearer tokens, so never log them.
- Patient phones cache the photo file for offline display. They re-download when the `etag` changes.
- Object keys are random (`p/{patientId}/m/{uuidv7}.jpg`), with no medicine names.

### Audit log
Written in the same transaction as the action. Visible to the patient's **current** owner via `GET /v1/patients/{id}/audit-log` ([D-066](01-decisions.md#d-066-security-baseline)).

| Action | Actor |
| --- | --- |
| `pairing.code_created`, `pairing.redeemed`, `pairing.code_locked` | caregiver / device |
| `device.revoked`, `device.token_rejected` | caregiver / system |
| `transfer.code_created`, `transfer.redeemed` (both sides) | caregiver |
| `patient.created`, `patient.updated`, `patient.archived`, `patient.reactivated`, `patient.timezone_changed` | caregiver / system |
| `medicine.created`, `medicine.updated`, `medicine.archived` | caregiver |
| `photo.read_url_issued` | system |
| `settings.updated` | caregiver |
| `billing.suspended`, `billing.restored` | system |
| `account.export_requested`, `account.deletion_requested` | caregiver |

`meta` never contains medicine names or notes, only IDs and changed field names.

### Observability scrubbing
([D-063](01-decisions.md#d-063-observability), [R-20](references.md))
- Sentry `beforeSend` / `beforeBreadcrumb` in app and API: drop request and response bodies. Strip fields named `name`, `notes`, `display_name`, `amount*`, `photo*`, `url`, `code`, `token`, `push_token`, `email`, `password`. Drop console breadcrumbs.
- `sendDefaultPii: false`. Identify users by internal UUID only.
- Server-side data scrubbing enabled in the Sentry project as a second layer.
- Session replay off.
- Application logs follow the same rules (structured logger with a deny-list serializer).

## DPDP mapping

India's Digital Personal Data Protection Act 2023 ([R-43](references.md)) and DPDP Rules 2025, G.S.R. 846(E) of 13 Nov 2025 ([R-44](references.md)). Most obligations (Rules 3, 5–16, 22, 23) **apply from 13 May 2027**. Build them into v1 anyway. Not legal advice; [C-10](01-decisions.md#c-10-dpdp-act-and-rules--owner--legal-counsel-review-before-phase-5) needs counsel.

| Requirement (source) | Our implementation |
| --- | --- |
| Consent: free, specific, informed, unambiguous, with clear affirmative action (Act s.6) | Explicit consent screens at caregiver signup and at patient pairing ([D-067](01-decisions.md#d-067-dpdp-and-store-compliance)), stored in `consents` (D-082) with notice version |
| Notice: standalone, plain language, itemised data + specified purpose, link to withdraw / exercise rights / complain to the Board (Rule 3) | Privacy notice in-app before consent; itemises: patient name, medicines, notes, photos, schedule, answers, device and permission data, push tokens. Purpose: reminders and caregiver alerts |
| Withdrawal as easy as giving (Act s.6(4), Rule 3(c)(i)) | Caregiver: Settings → withdraw consent / delete account. Patient: Settings → "Stop sharing", which unpairs and notifies the caregiver |
| Purpose limitation (Act s.4–6) | Data used only for reminders, alerts, billing and support. No ads, no analytics on health data. Sentry scrubbed |
| Security safeguards: encryption, access control, logs, backups (Rule 6) | Controls above |
| Log retention ≥ 1 year for detection/investigation (Rule 6(1)(e)); retain processing logs ≥ 1 year (Rule 8(3)) | Audit and notification logs retained ≥ 1 year, including after account deletion ([C-10](01-decisions.md#c-10-dpdp-act-and-rules--owner--legal-counsel-review-before-phase-5)(b)) |
| Breach intimation: each affected person without delay; the Board without delay and a detailed report within 72 h (Rule 7) | Incident runbook ([14](14-release-and-ops.md#incident-steps)); in-app notice + email to caregivers |
| Erasure on withdrawal or when purpose no longer served (Act s.8(7)) | Deletion pipeline: erase patient data, medicines, photos (R2 delete), dose history; keep minimal logs per Rule 8(3). **Indefinite retention of suspended data** ([D-056](01-decisions.md#d-056-suspended-data)) needs legal review |
| Contact person published (Act s.8(9), Rule 9) | Grievance/DPO contact in app (`/v1/app/config.grievance_contact`) and store listing ([OI-19](01-decisions.md#open-items)) |
| Grievance redressal ≤ 90 days (Act s.13, Rule 14(3)) | Support inbox with ticket tracking; SLA well under 90 days |
| Rights: access summary, correction, erasure, nominate (Act s.11–14) | Export (`POST /v1/me/export`), in-app edits, deletion (`POST /v1/me/delete`), nomination via grievance contact |
| Children (< 18) and persons with disability with a lawful guardian: verifiable consent of parent/guardian; no tracking or behavioural monitoring of children (Act s.9, Rules 10–11) | **Open** ([C-10](01-decisions.md#c-10-dpdp-act-and-rules--owner--legal-counsel-review-before-phase-5)(c)). Suggest asking at patient creation; legal review of adherence monitoring for minors |
| Data processors under contract (Act s.8(2), Rule 6(1)(f)) | DPAs with hosting, Cloudflare, Expo, RevenueCat, Sentry, email provider |
| Cross-border transfer (Act s.16, Rule 15) | Allowed unless restricted by notification; record processor regions; re-check before launch |

### Consent
- **Caregiver signup:** consent to the privacy notice + terms. Also a declaration that the caregiver may share the patient's data, and that the patient will be asked to consent at pairing ([C-10](01-decisions.md#c-10-dpdp-act-and-rules--owner--legal-counsel-review-before-phase-5)(d)).
- **Patient pairing:** the patient's own consent before the token is issued. Without it, no pairing.
- Notice version changes require re-consent on next app open.

## Store privacy

- Privacy policy URL in both stores and in-app ([D-067](01-decisions.md#d-067-dpdp-and-store-compliance)).
- Play Data safety form, Health apps declaration and App Store privacy details (D-088). Health info: collected, not shared, not used for ads. Encrypted in transit. Deletion available.
- Apple 5.1.3: no health data for ads or data mining; no personal health information in iCloud ([R-42](references.md)). We don't use iCloud; exclude the app's SQLite from iCloud backup (check expo-sqlite location and backup flags in Phase 3).
- Apple 5.1.1(v): in-app account deletion ([D-081](01-decisions.md#d-081-in-app-account-deletion)).
