import { DOSE_STATUSES } from '@med/shared';
import { z } from 'zod';

const when = z.iso.datetime({ error: 'must be an ISO date-time' });
const limit = z.coerce.number({ error: 'must be a number' }).int().min(1, { error: 'must be 1 to 100' }).max(100, { error: 'must be 1 to 100' });

export const dosesQuery = z.object({
  from: when.optional(),
  to: when.optional(),
  status: z.enum(DOSE_STATUSES, { error: 'is not a dose status' }).optional(),
  medicine_id: z.uuid({ error: 'must be a UUID' }).optional(),
  cursor: z.string().max(300).optional(),
  limit: limit.optional(),
});
export const adherenceQuery = z.object({ from: when.optional(), to: when.optional(), group_by: z.enum(['day', 'medicine'], { error: 'must be day or medicine' }).default('day') });
export const auditQuery = z.object({ cursor: z.string().max(300).optional(), limit: limit.optional() });
