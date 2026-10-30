import { PLATFORMS } from '@med/shared';
import { z } from 'zod';
import { deviceInfo } from '../auth/auth.dto.js';

export const challengeBody = z.object({ platform: z.enum(PLATFORMS, { error: 'must be ios or android' }) });

// Attestation is accepted and recorded, not verified yet (D-013 is log-only; see docs/06).
const attestation = z.object({
  platform: z.enum(PLATFORMS),
  token: z.string().max(20_000).optional(),
  key_id: z.string().max(512).optional(),
  attestation_object: z.string().max(20_000).optional(),
  challenge: z.string().max(512),
});

export const redeemBody = z.object({
  code: z.string({ error: 'is required' }).min(1, { error: 'is required' }).max(32),
  device: deviceInfo.extend({ install_id: z.string({ error: 'is required' }).min(8).max(64) }),
  attestation: attestation.optional(),
  consent: z.object({ notice_version: z.string({ error: 'is required' }).min(1).max(32) }, { error: 'is required' }),
});
export type RedeemBody = z.infer<typeof redeemBody>;
