import { Module } from '@nestjs/common';
import { DosesModule } from '../doses/doses.module.js';
import { EntitlementsService } from './entitlements.service.js';
import { FakeRevenueCatClient, HttpRevenueCatClient, RevenueCatClient } from './revenuecat/revenuecat-client.js';
import { SubscriptionSyncService } from './revenuecat/subscription-sync.service.js';
import { RevenueCatWebhookController } from './revenuecat/webhook.controller.js';
import { SubscriptionController } from './subscription.controller.js';

@Module({
  imports: [DosesModule],
  controllers: [SubscriptionController, RevenueCatWebhookController],
  providers: [
    EntitlementsService,
    SubscriptionSyncService,
    {
      provide: RevenueCatClient,
      useFactory: (): RevenueCatClient => {
        const { REVENUECAT_API_KEY: key, REVENUECAT_PROJECT_ID: project } = process.env;
        if (key && project) return new HttpRevenueCatClient(key, project);
        if (process.env.NODE_ENV === 'production') throw new Error('REVENUECAT_API_KEY, REVENUECAT_PROJECT_ID and REVENUECAT_WEBHOOK_AUTH are required in production');
        return new FakeRevenueCatClient(false); // dev: subscription state is left alone
      },
    },
  ],
  exports: [EntitlementsService, SubscriptionSyncService],
})
export class BillingModule {}
