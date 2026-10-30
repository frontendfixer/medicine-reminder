import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../../auth/public.decorator.js';
import { ApiException } from '../../common/api-exception.js';
import { parse } from '../../common/parse.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/database.module.js';
import { rcWebhookEvents } from '../../db/schema.js';
import { SkipIdempotency } from '../../idempotency/skip-idempotency.decorator.js';

const body = z.object({
  event: z.object({
    id: z.string().min(1).max(200),
    type: z.string().min(1).max(64),
    app_user_id: z.string().max(200).optional(),
    original_app_user_id: z.string().max(200).optional(),
    aliases: z.array(z.string().max(200)).max(50).optional(),
    environment: z.string().max(20).optional(),
    event_timestamp_ms: z.number().optional(),
  }),
});

function authorized(header: string | undefined): boolean {
  const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!expected || !header) return false; // not configured means nothing is accepted
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// docs/07-subscriptions-and-billing.md#revenuecat-webhooks. Verify, record, answer 200 fast. Processing happens in the
// worker, which re-reads the customer from RevenueCat; this endpoint never trusts the event body for state.
@Controller('v1/webhooks')
export class RevenueCatWebhookController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @SkipIdempotency()
  @Post('revenuecat')
  @HttpCode(200)
  async receive(@Body() raw: unknown, @Headers('authorization') authorization: string | undefined) {
    if (!authorized(authorization)) throw new ApiException('UNAUTHENTICATED', 'Not authorised.');
    const { event } = parse(body, raw);
    // Retries reuse the event ID, so a repeat is a no-op (D-051).
    await this.db
      .insert(rcWebhookEvents)
      .values({ eventId: event.id, type: event.type, appUserId: event.app_user_id ?? null, eventTimestamp: event.event_timestamp_ms ? new Date(event.event_timestamp_ms) : null, payload: event })
      .onConflictDoNothing();
    return {};
  }
}
