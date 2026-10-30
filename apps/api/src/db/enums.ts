import {
  DOSE_STATUSES,
  LOCKSCREEN_DETAILS,
  NOTIFICATION_KINDS,
  NOTIFICATION_TYPES,
  PAIRING_CODE_KINDS,
  PATIENT_STATUSES,
  PATIENT_TYPES,
  PLATFORMS,
  SCHEDULE_PATTERNS,
  SUBSCRIPTION_STATUSES,
  TZ_MODES,
} from '@med/shared';
import { enumOf } from './columns.js';

// Names and values: docs/03-data-model.md#canonical-enums
export const patientType = enumOf('patient_type', PATIENT_TYPES);
export const patientStatus = enumOf('patient_status', PATIENT_STATUSES);
export const tzMode = enumOf('tz_mode', TZ_MODES);
export const notificationType = enumOf('notification_type', NOTIFICATION_TYPES);
export const schedulePattern = enumOf('schedule_pattern', SCHEDULE_PATTERNS);
export const doseStatus = enumOf('dose_status', DOSE_STATUSES);
export const pairingCodeKind = enumOf('pairing_code_kind', PAIRING_CODE_KINDS);
export const notificationKind = enumOf('notification_kind', NOTIFICATION_KINDS);
export const lockscreenDetail = enumOf('lockscreen_detail', LOCKSCREEN_DETAILS);
export const platform = enumOf('platform', PLATFORMS);
export const subscriptionStatus = enumOf('subscription_status', SUBSCRIPTION_STATUSES);
