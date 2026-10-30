import { LOCKSCREEN_DETAILS, PATIENT_STATUSES, PATIENT_TYPES, TZ_MODES } from '@med/shared';
import { z } from 'zod';

// Accepts IANA names such as "Asia/Kolkata" and "UTC"; rejects abbreviations like "EST" and unknown names.
export function isIanaTimeZone(value: string): boolean {
  if (value !== 'UTC' && !value.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const displayName = z.string({ error: 'is required' }).trim().min(1, { error: 'is required' }).max(80, { error: 'is too long' });
const timezone = z.string({ error: 'is required' }).refine(isIanaTimeZone, { error: 'must be an IANA time zone such as Asia/Kolkata' });
const tzMode = z.enum(TZ_MODES, { error: 'must be follow_device or fixed' });
// Suggested cap of one day; the database only requires a positive number.
const missedDelay = z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).max(1440, { error: 'must be at most 1440' });
const lockscreenDetail = z.enum(LOCKSCREEN_DETAILS, { error: 'must be full or generic' });

export const createPatientBody = z.object({
  display_name: displayName,
  type: z.enum(PATIENT_TYPES, { error: 'must be managed or self' }),
  timezone,
  tz_mode: tzMode.default('follow_device'),
  missed_delay_min: missedDelay.optional(),
});

// null clears an override back to the caregiver default.
export const updatePatientBody = z
  .strictObject({
    display_name: displayName,
    timezone,
    tz_mode: tzMode,
    missed_delay_min: missedDelay.nullable(),
    lockscreen_detail: lockscreenDetail.nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { error: 'at least one field is required' });

export const listPatientsQuery = z.object({ status: z.enum(PATIENT_STATUSES, { error: 'must be active, suspended or archived' }).optional() });

export type CreatePatientBody = z.infer<typeof createPatientBody>;
export type UpdatePatientBody = z.infer<typeof updatePatientBody>;
