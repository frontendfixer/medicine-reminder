// Canonical enum values. Spelling is fixed by docs/03-data-model.md; change the doc first.
export const PATIENT_TYPES = ['managed', 'self'] as const;
export const PATIENT_STATUSES = ['active', 'suspended', 'archived'] as const;
export const TZ_MODES = ['follow_device', 'fixed'] as const;
export const NOTIFICATION_TYPES = ['standard', 'alarm', 'gentle'] as const;
export const SCHEDULE_PATTERNS = ['daily', 'weekdays', 'every_n_days'] as const;
export const DOSE_STATUSES = ['pending', 'snoozed', 'taken', 'not_taken', 'missed'] as const;
export const PAIRING_CODE_KINDS = ['pair', 'transfer'] as const;
export const NOTIFICATION_KINDS = [
  'backup',
  'missed',
  'correction',
  'device_health',
  'not_taken',
  'window_low',
  'billing',
  'pairing',
  'sync',
] as const;
export const LOCKSCREEN_DETAILS = ['full', 'generic'] as const;
export const PLATFORMS = ['ios', 'android'] as const;
export const SUBSCRIPTION_STATUSES = ['active', 'store_grace', 'grace', 'expired'] as const;

export type PatientType = (typeof PATIENT_TYPES)[number];
export type PatientStatus = (typeof PATIENT_STATUSES)[number];
export type TzMode = (typeof TZ_MODES)[number];
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type SchedulePattern = (typeof SCHEDULE_PATTERNS)[number];
export type DoseStatus = (typeof DOSE_STATUSES)[number];
export type PairingCodeKind = (typeof PAIRING_CODE_KINDS)[number];
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type LockscreenDetail = (typeof LOCKSCREEN_DETAILS)[number];
export type Platform = (typeof PLATFORMS)[number];
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
