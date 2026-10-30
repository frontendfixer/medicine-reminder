import { z } from 'zod';
import { isIanaTimeZone } from '../patients/patients.dto.js';

export const heartbeatBody = z.object({
  push_token: z.string().max(200).optional(),
  permissions: z.object({
    notifications: z.boolean(),
    exact_alarm: z.boolean().optional(),
    battery_unrestricted: z.boolean().optional(),
    time_sensitive: z.boolean().optional(),
  }),
  app_version: z.string().min(1).max(32),
  tz: z.string().refine(isIanaTimeZone, { error: 'must be an IANA time zone' }),
  scheduled_through: z.iso.datetime({ error: 'must be an ISO date-time' }).nullable(),
});
export type HeartbeatBody = z.infer<typeof heartbeatBody>;
