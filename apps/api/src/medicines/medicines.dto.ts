import { NOTIFICATION_TYPES, SCHEDULE_PATTERNS } from '@med/shared';
import { z } from 'zod';

const missedDelay = z.number({ error: 'must be a number' }).int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).max(1440, { error: 'must be at most 1440' });
const isoDate = z.iso.date({ error: 'must be a date like 2026-11-01' });
const localTime = z.string({ error: 'is required' }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'must be HH:MM, 00:00 to 23:59' });

export const scheduleInput = z
  .object({
    pattern: z.enum(SCHEDULE_PATTERNS, { error: 'must be daily, weekdays or every_n_days' }),
    days_of_week: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullish(),
    interval_days: z.number().int().min(2, { error: 'must be at least 2' }).max(365).nullish(),
    start_date: isoDate,
    end_date: isoDate.nullish(),
    times: z
      .array(z.object({ local_time: localTime, amount_text: z.string({ error: 'is required' }).trim().min(1, { error: 'is required' }).max(60, { error: 'is too long' }) }), { error: 'is required' })
      .min(1, { error: 'at least one time is required' })
      .max(12, { error: 'at most 12 times' }),
  })
  .superRefine((s, ctx) => {
    if (s.pattern === 'weekdays' && !s.days_of_week?.length) ctx.addIssue({ code: 'custom', path: ['days_of_week'], message: 'is required for weekdays' });
    if (s.pattern === 'weekdays' && new Set(s.days_of_week).size !== s.days_of_week?.length) ctx.addIssue({ code: 'custom', path: ['days_of_week'], message: 'must not repeat a day' });
    if (s.pattern === 'every_n_days' && !s.interval_days) ctx.addIssue({ code: 'custom', path: ['interval_days'], message: 'is required for every_n_days' });
    if (s.end_date && s.end_date < s.start_date) ctx.addIssue({ code: 'custom', path: ['end_date'], message: 'must not be before start_date' });
    if (new Set(s.times.map((t) => t.local_time)).size !== s.times.length) ctx.addIssue({ code: 'custom', path: ['times'], message: 'times must be different' });
  });

const fields = {
  name: z.string({ error: 'is required' }).trim().min(1, { error: 'is required' }).max(120, { error: 'is too long' }),
  notes: z.string().trim().max(1000, { error: 'is too long' }).nullable(),
  photo_object_key: z.string().max(200).nullable(),
  notification_type: z.enum(NOTIFICATION_TYPES, { error: 'must be standard, alarm or gentle' }),
  missed_delay_min: missedDelay.nullable(),
  schedule: scheduleInput,
};

export const createMedicineBody = z.object({
  name: fields.name,
  notes: fields.notes.optional(),
  photo_object_key: fields.photo_object_key.optional(),
  notification_type: fields.notification_type.default('standard'),
  missed_delay_min: fields.missed_delay_min.optional(),
  schedule: fields.schedule,
});

export const updateMedicineBody = z
  .strictObject({ name: fields.name, notes: fields.notes, photo_object_key: fields.photo_object_key, notification_type: fields.notification_type, missed_delay_min: fields.missed_delay_min, schedule: fields.schedule })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: 'at least one field is required' });

export const listMedicinesQuery = z.object({ include_archived: z.enum(['true', 'false']).optional() });

export type CreateMedicineBody = z.infer<typeof createMedicineBody>;
export type UpdateMedicineBody = z.infer<typeof updateMedicineBody>;
export type ScheduleBody = z.infer<typeof scheduleInput>;
