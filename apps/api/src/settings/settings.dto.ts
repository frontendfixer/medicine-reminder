import { LOCKSCREEN_DETAILS } from '@med/shared';
import { z } from 'zod';

export const updateSettingsBody = z
  .strictObject({
    default_missed_delay_min: z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).max(1440, { error: 'must be at most 1440' }),
    lockscreen_detail: z.enum(LOCKSCREEN_DETAILS, { error: 'must be full or generic' }),
    daily_summary: z.boolean({ error: 'must be true or false' }), // stored, unused until v1.1 (D-070)
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: 'at least one field is required' });
export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>;
