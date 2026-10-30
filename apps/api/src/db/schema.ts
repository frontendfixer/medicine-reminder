// Tables and constraints: docs/03-data-model.md. Change the doc first, then this file.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, id, ts } from './columns.js';
import {
  doseStatus,
  lockscreenDetail,
  notificationKind,
  notificationType,
  pairingCodeKind,
  patientStatus,
  patientType,
  platform,
  schedulePattern,
  subscriptionStatus,
  tzMode,
} from './enums.js';

export * from './enums.js';

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text().notNull(), // trimmed, lower-cased; not verified in v1 (D-095)
    passwordHash: text('password_hash').notNull(), // Argon2id PHC string (D-095)
    createdAt: ts('created_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'), // account deletion (D-081)
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const caregiverSettings = pgTable(
  'caregiver_settings',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    defaultMissedDelayMin: integer('default_missed_delay_min').notNull().default(30),
    lockscreenDetail: lockscreenDetail('lockscreen_detail').notNull().default('full'),
    dailySummary: boolean('daily_summary').notNull().default(false), // v1.1 (D-082)
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('missed_delay_positive', sql`${t.defaultMissedDelayMin} > 0`)],
);

export const patients = pgTable(
  'patients',
  {
    id: id(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    displayName: bytea('display_name').notNull(), // encrypted (D-082)
    type: patientType().notNull().default('managed'),
    timezone: text().notNull(), // IANA, e.g. "Asia/Kolkata"
    tzMode: tzMode('tz_mode').notNull().default('follow_device'),
    missedDelayMin: integer('missed_delay_min'), // null → caregiver default
    lockscreenDetail: lockscreenDetail('lockscreen_detail'), // null → caregiver setting
    status: patientStatus().notNull().default('active'),
    suspendedAt: ts('suspended_at'),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('patients_owner_idx').on(t.ownerUserId, t.status),
    // one self profile per caregiver (D-092)
    uniqueIndex('patients_one_self_uq')
      .on(t.ownerUserId)
      .where(sql`${t.type} = 'self' and ${t.status} <> 'archived'`),
    check('patients_missed_delay_positive', sql`${t.missedDelayMin} is null or ${t.missedDelayMin} > 0`),
  ],
);

// A row is either a caregiver login device (user_id) or a patient device (patient_id).
export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id),
    patientId: uuid('patient_id').references(() => patients.id),
    tokenHash: text('token_hash'), // patient devices: HMAC-SHA256 of the device token
    pushToken: text('push_token'), // ExponentPushToken[...]
    pushInvalidAt: ts('push_invalid_at'), // set on DeviceNotRegistered (D-082)
    platform: platform().notNull(),
    label: text(), // "Pixel 8", shown to the caregiver (D-082)
    appVersion: text('app_version'),
    tz: text(), // IANA reported by the phone
    permNotifications: boolean('perm_notifications'),
    permExactAlarm: boolean('perm_exact_alarm'), // Android
    permBatteryUnrestricted: boolean('perm_battery_unrestricted'), // Android
    permTimeSensitive: boolean('perm_time_sensitive'), // iOS
    scheduledThrough: ts('scheduled_through'),
    lastSeenAt: ts('last_seen_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('devices_one_owner', sql`(${t.userId} is null) <> (${t.patientId} is null)`),
    check('devices_patient_has_token', sql`${t.patientId} is null or ${t.tokenHash} is not null`),
    uniqueIndex('devices_token_hash_uq')
      .on(t.tokenHash)
      .where(sql`${t.tokenHash} is not null`),
    // one active login per caregiver (D-019)
    uniqueIndex('devices_one_caregiver_login_uq')
      .on(t.userId)
      .where(sql`${t.userId} is not null and ${t.revokedAt} is null`),
    index('devices_patient_active_idx')
      .on(t.patientId)
      .where(sql`${t.revokedAt} is null`),
    // At most 3 active per patient is enforced in the redeem transaction (D-018, D-084).
  ],
);

export const pairingCodes = pgTable(
  'pairing_codes',
  {
    id: id(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    kind: pairingCodeKind().notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    lookupHash: text('lookup_hash').notNull(), // HMAC of the first 4 symbols (D-084)
    codeHash: text('code_hash').notNull(), // HMAC-SHA256(pepper, normalised 8 symbols)
    expiresAt: ts('expires_at').notNull(), // created_at + 10 min
    usedAt: ts('used_at'),
    invalidatedAt: ts('invalidated_at'), // superseded by a newer code for the same patient and kind
    failedAttempts: smallint('failed_attempts').notNull().default(0), // 5 → locked
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    // at most one live code per patient and kind
    uniqueIndex('pairing_codes_live_uq')
      .on(t.patientId, t.kind)
      .where(sql`${t.usedAt} is null and ${t.invalidatedAt} is null`),
    index('pairing_codes_lookup_idx')
      .on(t.lookupHash)
      .where(sql`${t.usedAt} is null and ${t.invalidatedAt} is null`),
  ],
);

export const medicines = pgTable(
  'medicines',
  {
    id: id(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    name: bytea().notNull(), // encrypted
    notes: bytea(), // encrypted
    photoObjectKey: text('photo_object_key'), // R2 key (D-082)
    notificationType: notificationType('notification_type').notNull().default('standard'),
    missedDelayMin: integer('missed_delay_min'), // null → patient → caregiver default
    stockCount: integer('stock_count'), // v1.1
    lowStockAt: integer('low_stock_at'), // v1.1
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('medicines_patient_idx')
      .on(t.patientId)
      .where(sql`${t.archivedAt} is null`),
    check('medicines_missed_delay_positive', sql`${t.missedDelayMin} is null or ${t.missedDelayMin} > 0`),
  ],
);

export const scheduleVersions = pgTable(
  'schedule_versions',
  {
    id: id(),
    medicineId: uuid('medicine_id')
      .notNull()
      .references(() => medicines.id),
    effectiveFrom: ts('effective_from').notNull(),
    effectiveUntil: ts('effective_until'), // null = current version
    pattern: schedulePattern().notNull(),
    daysOfWeek: smallint('days_of_week').array(), // ISO 1=Mon..7=Sun; required for 'weekdays'
    intervalDays: smallint('interval_days'), // required for 'every_n_days' (≥ 2)
    startDate: date('start_date').notNull(), // local date; anchor for every_n_days
    endDate: date('end_date'), // null = runs while the subscription is active
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('schedule_versions_current_uq')
      .on(t.medicineId)
      .where(sql`${t.effectiveUntil} is null`),
    // A CHECK passes when its expression is NULL, so each required column is coalesced to false.
    check(
      'sv_weekdays',
      sql`${t.pattern} <> 'weekdays' or coalesce(cardinality(${t.daysOfWeek}) between 1 and 7 and ${t.daysOfWeek} <@ array[1,2,3,4,5,6,7]::smallint[], false)`,
    ),
    check('sv_interval', sql`${t.pattern} <> 'every_n_days' or coalesce(${t.intervalDays} >= 2, false)`),
    check('sv_dates', sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`),
  ],
);

export const scheduleTimes = pgTable(
  'schedule_times',
  {
    id: id(),
    scheduleVersionId: uuid('schedule_version_id')
      .notNull()
      .references(() => scheduleVersions.id),
    localTime: time('local_time').notNull(), // minute precision, e.g. 08:00
    amountText: text('amount_text').notNull(), // "1 tablet"
  },
  (t) => [unique('schedule_times_uq').on(t.scheduleVersionId, t.localTime)],
);

export const doseInstances = pgTable(
  'dose_instances',
  {
    id: id(), // also the local notification identifier
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id),
    medicineId: uuid('medicine_id')
      .notNull()
      .references(() => medicines.id),
    scheduleVersionId: uuid('schedule_version_id')
      .notNull()
      .references(() => scheduleVersions.id),
    scheduledAt: ts('scheduled_at').notNull(), // UTC instant
    localTime: time('local_time').notNull(), // wall-clock time it represents
    nameSnapshot: bytea('name_snapshot').notNull(), // encrypted
    amountSnapshot: text('amount_snapshot').notNull(),
    alertDueAt: ts('alert_due_at').notNull(), // scheduled_at + resolved delay, frozen (D-082)
    status: doseStatus().notNull().default('pending'),
    snoozeUntil: ts('snooze_until'),
    respondedAt: ts('responded_at'), // device clock
    receivedAt: ts('received_at'), // server clock
    clientEventId: uuid('client_event_id'),
    pushSentAt: ts('push_sent_at'), // backup evaluation done, whether or not a push was needed
    alertSentAt: ts('alert_sent_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('dose_medicine_time_uq').on(t.medicineId, t.scheduledAt),
    uniqueIndex('dose_client_event_uq')
      .on(t.clientEventId)
      .where(sql`${t.clientEventId} is not null`),
    // sweeper: backup push pass
    index('dose_push_due_idx')
      .on(t.scheduledAt)
      .where(sql`${t.pushSentAt} is null and ${t.status} in ('pending','snoozed')`),
    // sweeper: missed-alert pass
    index('dose_alert_due_idx')
      .on(t.alertDueAt)
      .where(sql`${t.alertSentAt} is null and ${t.status} in ('pending','snoozed')`),
    index('dose_patient_time_idx').on(t.patientId, t.scheduledAt),
  ],
);

// Also the outbox: rows are inserted in the sweeper transaction, then sent.
export const notificationLog = pgTable(
  'notification_log',
  {
    id: id(),
    kind: notificationKind().notNull(),
    patientId: uuid('patient_id').references(() => patients.id),
    deviceId: uuid('device_id').references(() => devices.id), // target
    doseInstanceId: uuid('dose_instance_id').references(() => doseInstances.id),
    groupKey: text('group_key'), // collapse id for 15-min grouping
    status: text().notNull().default('queued'), // queued | sent | failed
    expoTicketId: text('expo_ticket_id'),
    ticketStatus: text('ticket_status'), // ok | error
    ticketError: text('ticket_error'),
    receiptStatus: text('receipt_status'), // ok | error
    receiptError: text('receipt_error'), // e.g. DeviceNotRegistered
    createdAt: ts('created_at').notNull().defaultNow(),
    sentAt: ts('sent_at'),
    receiptCheckedAt: ts('receipt_checked_at'),
  },
  (t) => [
    check('nlog_status', sql`${t.status} in ('queued','sent','failed')`),
    index('nlog_queued_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'queued'`),
    index('nlog_receipt_due_idx')
      .on(t.sentAt)
      .where(sql`${t.expoTicketId} is not null and ${t.receiptCheckedAt} is null`),
    index('nlog_device_kind_idx').on(t.deviceId, t.kind, t.createdAt), // 12 h device-alert throttle
    index('nlog_patient_kind_idx').on(t.patientId, t.kind, t.createdAt), // 15 min grouping
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id), // row locked for quota checks (D-053)
    plan: text().notNull(), // "starter"; others are OI-01
    patientLimit: integer('patient_limit').notNull(), // starter = 3
    status: subscriptionStatus().notNull(),
    renewsAt: ts('renews_at'),
    expiredAt: ts('expired_at'), // store-reported expiry (D-082)
    cutoffAt: ts('cutoff_at'), // expired_at + 1 day (D-082)
    providerRef: text('provider_ref').notNull(), // RevenueCat app_user_id (= users.id)
    lastEventId: text('last_event_id'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('subscriptions_cutoff_idx')
      .on(t.cutoffAt)
      .where(sql`${t.status} = 'grace'`),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actorType: text('actor_type').notNull(), // caregiver | device | system
    actorId: uuid('actor_id'),
    patientId: uuid('patient_id'), // visible to the patient's current owner
    action: text().notNull(), // see docs/10-security-privacy.md#audit-log
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    meta: jsonb(), // never medicine names or notes
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('audit_actor_type', sql`${t.actorType} in ('caregiver','device','system')`),
    index('audit_patient_idx').on(t.patientId, t.createdAt),
    index('audit_actor_idx').on(t.actorId, t.createdAt),
  ],
);

// ── Supporting tables (D-082) ────────────────────────────────────────────

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    deviceId: uuid('device_id').references(() => devices.id),
    refreshHash: text('refresh_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    // one active login (D-019)
    uniqueIndex('auth_sessions_one_active_uq')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
    uniqueIndex('auth_sessions_refresh_uq').on(t.refreshHash),
  ],
);

// Kept 24 hours, scoped per principal (D-083).
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    principal: uuid().notNull(), // user id or device id
    key: text().notNull(),
    methodPath: text('method_path').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: smallint('status_code'),
    responseBody: jsonb('response_body'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.principal, t.key] }), index('idempotency_created_idx').on(t.createdAt)],
);

export const rcWebhookEvents = pgTable('rc_webhook_events', {
  eventId: text('event_id').primaryKey(),
  type: text().notNull(),
  appUserId: text('app_user_id'),
  eventTimestamp: ts('event_timestamp'),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
});

// DPDP proof of consent (D-067, C-10).
export const consents = pgTable(
  'consents',
  {
    id: id(),
    subjectType: text('subject_type').notNull(), // caregiver | patient
    userId: uuid('user_id').references(() => users.id),
    patientId: uuid('patient_id').references(() => patients.id),
    deviceId: uuid('device_id').references(() => devices.id),
    kind: text().notNull(), // signup | pairing
    noticeVersion: text('notice_version').notNull(),
    givenAt: ts('given_at').notNull().defaultNow(),
    withdrawnAt: ts('withdrawn_at'),
  },
  (t) => [
    check('consents_subject', sql`${t.subjectType} in ('caregiver','patient')`),
    check('consents_kind', sql`${t.kind} in ('signup','pairing')`),
    index('consents_user_idx').on(t.userId),
    index('consents_patient_idx').on(t.patientId),
  ],
);
