import { z } from 'zod';

export const syncQuery = z.object({ cursor: z.string().max(200).optional() });

const response = z.object({
  client_event_id: z.uuid({ error: 'must be a UUID' }),
  dose_id: z.uuid({ error: 'must be a UUID' }),
  action: z.enum(['taken', 'not_taken', 'snooze'], { error: 'must be taken, not_taken or snooze' }),
  responded_at: z.iso.datetime({ error: 'must be an ISO date-time' }),
  network_restored_at: z.iso.datetime({ error: 'must be an ISO date-time' }).nullish(),
});
export const doseResponsesBody = z.object({ responses: z.array(response, { error: 'is required' }).min(1, { error: 'at least one response is required' }).max(100, { error: 'at most 100 responses' }) });
export type DoseResponseItem = z.infer<typeof response>;
