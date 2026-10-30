import { Module } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service.js';
import { SubscriptionController } from './subscription.controller.js';

@Module({
  controllers: [SubscriptionController],
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class BillingModule {}
