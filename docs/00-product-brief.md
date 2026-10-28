# Product brief

## Problem

People on regular medication miss doses, and the family members who look after them usually find out too late. Existing reminder apps assume the patient configures everything and keeps the app healthy. Many patients (elderly, unwell, not tech-confident) can't do that. The caregiver needs to set it up remotely and hear about it when a dose goes unanswered.

**Reminder reliability is the product.** Everything else is CRUD.

The app is a reminder tool, not medical advice, and shows a disclaimer ([D-005](01-decisions.md#d-005-disclaimer)).

## Users

| User | Who | What they do | Account |
| --- | --- | --- | --- |
| **Caregiver** | Usually a family member | Adds patients, enters medicines and schedules, pairs the patient's phone, receives missed-dose and device-problem alerts, pays the subscription | Signs in with email + password (v1). One active login ([D-019](01-decisions.md#d-019-one-caregiver-login)) |
| **Patient** | The person taking the medicines | Configures nothing. Gets reminders on time and answers **Taken**, **Not taken** or **Snooze 10 min** | No sign-in. A device token from pairing; up to 3 devices ([D-018](01-decisions.md#d-018-up-to-3-patient-devices)) |
| **Self profile** | A caregiver tracking their own medicines | Same as a patient, on the caregiver's own phone | Part of the caregiver account. Doesn't count toward the patient limit but needs an active subscription ([D-008](01-decisions.md#d-008-self-profile)) |

One phone can hold a caregiver account and a paired patient profile at the same time ([D-009](01-decisions.md#d-009-dual-roles-on-one-phone)).

## Core flows

### 1. Caregiver signs up and subscribes
1. Install the app and choose *I look after someone*.
2. Register with email + password (no email verification in v1), and give explicit consent (privacy notice). Email OTP, Google and Apple sign-in come in v1.1.
3. Choose a plan (Starter = 3 managed patients; others open, [OI-01](01-decisions.md#open-items)) and purchase through the store via RevenueCat.
4. The server verifies the entitlement and the account becomes active ([07](07-subscriptions-and-billing.md)).

### 2. Caregiver adds a patient and medicines
1. *Add patient*: name, timezone mode (follow device or fixed), optional missed-dose delay override (default 30 min).
2. The server checks quota inside a transaction ([D-053](01-decisions.md#d-053-server-only-quota)).
3. *Add medicine*: name, notes, optional photo (compressed on the phone, uploaded to R2), notification type (Standard, Alarm, Gentle), optional missed delay.
4. Schedule: daily, chosen weekdays or every N days. One or more times, each with its own amount. Start date, optional end date.
5. The server creates the schedule version and generates dose instances 14 days ahead ([05](05-reminder-engine.md#dose-generation)).

### 3. Pairing the patient's phone
1. Caregiver taps *Generate code* and gets `XXXX-XXXX` plus a QR code, valid 10 minutes.
2. The caregiver hands the code over in person or in a trusted chat.
3. The patient installs the app, chooses *I take medicines*, and scans or types the code. The patient gives consent.
4. The server issues a device token, stored in the secure store.
5. The caregiver sees "Patient connected on [device, time]" with Revoke and Re-pair ([06](06-pairing-and-devices.md)).
6. Mandatory guided setup on the patient phone: notifications; on Android, exact alarms and battery whitelisting; on iOS, time-sensitive notifications. Skipped permissions are reported to the caregiver ([08](08-notifications-and-platform.md#permission-onboarding)).
7. The phone syncs its dose window and schedules local notifications.

### 4. A dose is due
1. A local notification fires at the scheduled time, using the medicine's notification type. Alarm repeats every 5 minutes until answered or the missed delay ends.
2. The patient answers from the lock screen or the Today screen: Taken, Not taken or Snooze 10 min.
3. The answer is saved to local SQLite and synced, and the dose clears on the patient's other devices.
4. If the phone is unhealthy (window too short, no check-in for 12 h, permission off), the server sends a push backup at the due time ([05](05-reminder-engine.md#conditional-push-backup)).

### 5. A dose goes unanswered
1. At `scheduled_at + delay` the sweeper marks the dose `missed` and alerts the caregiver: "No answer recorded for [medicine, amount] at [time]".
2. Several misses for one patient within 15 minutes arrive as one grouped alert.
3. If the patient answers later, the status flips and the caregiver gets a short correction ([09](09-missed-dose-alerts.md)).
4. A **Not taken** answer alerts the caregiver immediately.

### 6. Device problem
- No heartbeat for 6 h while doses are scheduled, a required permission off, or a window under 24 h: the caregiver gets a device problem alert, at most once per 12 h per device ([09](09-missed-dose-alerts.md#device-problem-alerts)).

### 7. Editing a medicine
- Editing closes the current schedule version and opens a new one effective from now. Future pending doses are regenerated; history keeps name and amount snapshots. Medicines are archived, never deleted.

### 8. Transfer
1. The owner generates a transfer code. The receiving caregiver redeems it and must have free quota.
2. Medicines, full history, pairing and devices move intact. The old caregiver loses access. Both sides are audited ([06](06-pairing-and-devices.md#transfer)).

### 9. Patient becomes caregiver
- Subscribing inside the app creates a separate caregiver account on the same phone. To self-manage their own profile, the current owner transfers it to them and it becomes their self profile.

### 10. Subscription lapses
1. The store's billing grace runs first. After the store reports the subscription expired, there is 1 day of grace. The caregiver is warned at expiry and 6 hours before cutoff. Patient devices show "Reminders stop tomorrow, ask your caregiver".
2. At cutoff, all patients and the self profile are suspended. Devices cancel their alarms and show "Reminders paused".
3. Data is kept read-only. Renewing restores everything and re-syncs alarms within a minute ([07](07-subscriptions-and-billing.md)).

## Out of scope (v1)

- SMS, phone call or email fallback for reminders or alerts.
- Notifying anyone other than the owner caregiver and the patient (no family fan-out, no co-caregivers).
- Drug database, interaction checks, dosage advice, any medical advice.
- Languages other than English (strings are externalised for later).
- Pill stock tracking and low-stock alerts, evening adherence summary, read-aloud (all v1.1).
- Email verification, email OTP, Google and Apple sign-in (v1.1). No password reset or change in v1 ([D-096](01-decisions.md#d-096-8-character-password-minimum-no-password-reset-in-v1)).
- Quiet hours for missed-dose alerts.
- Web app or desktop clients.
- Expo Go support.
