import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { AuthedRequest } from '../common/principal.js';
import { EntitlementsService } from './entitlements.service.js';
import { SubscriptionSyncService } from './revenuecat/subscription-sync.service.js';

@Controller('v1/subscription')
export class SubscriptionController {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly sync: SubscriptionSyncService,
  ) {}

  // docs/04-api.md#subscription. Always the caller's own subscription: there is no ID in the path.
  @Get()
  get(@Req() req: AuthedRequest) {
    return this.entitlements.summary(req.principal!.id);
  }

  // After a purchase or restore the app asks the server to look again; the client never decides entitlement (07).
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: AuthedRequest) {
    await this.sync.sync(req.principal!.id);
    return this.entitlements.summary(req.principal!.id);
  }
}
