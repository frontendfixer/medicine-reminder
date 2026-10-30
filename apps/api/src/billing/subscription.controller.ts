import { Controller, Get, Req } from '@nestjs/common';
import type { AuthedRequest } from '../common/principal.js';
import { EntitlementsService } from './entitlements.service.js';

@Controller('v1/subscription')
export class SubscriptionController {
  constructor(private readonly entitlements: EntitlementsService) {}

  // docs/04-api.md#subscription. Always the caller's own subscription: there is no ID in the path.
  // `POST /v1/subscription/refresh` arrives with RevenueCat in Phase 4.
  @Get()
  get(@Req() req: AuthedRequest) {
    return this.entitlements.summary(req.principal!.id);
  }
}
