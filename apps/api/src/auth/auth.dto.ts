import { PLATFORMS } from '@med/shared';
import { z } from 'zod';

// Emails are trimmed and lower-cased (docs/04-api.md#auth). Length counts code points, no composition rules (D-096).
const email = z
  .string({ error: 'is required' })
  .trim()
  .toLowerCase()
  .max(254, { error: 'is too long' })
  .pipe(z.email({ error: 'must be an email address' }));

const newPassword = z
  .string({ error: 'is required' })
  .min(8, { error: 'must be 8 to 128 characters' })
  .max(128, { error: 'must be 8 to 128 characters' });

const device = z.object(
  {
    platform: z.enum(PLATFORMS, { error: 'must be ios or android' }),
    app_version: z.string({ error: 'is required' }).min(1).max(32),
    label: z.string().max(64).optional(),
    push_token: z.string().max(200).optional(),
    tz: z.string().min(1).max(64).optional(),
  },
  { error: 'is required' },
);

export const registerBody = z.object({
  email,
  password: newPassword,
  device,
  consent: z.object({ notice_version: z.string({ error: 'is required' }).min(1).max(32) }, { error: 'is required' }),
});

// Login accepts any non-empty password so a policy change never turns into a distinguishable error.
export const loginBody = z.object({
  email,
  password: z.string({ error: 'is required' }).min(1, { error: 'is required' }).max(1024),
  device,
});

export const refreshBody = z.object({ refresh_token: z.string({ error: 'is required' }).min(1).max(256) });

export type RegisterBody = z.infer<typeof registerBody>;
export type LoginBody = z.infer<typeof loginBody>;
export type DeviceInfo = z.infer<typeof device>;
