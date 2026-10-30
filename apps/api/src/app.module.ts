import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { AuthModule } from './auth/auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { DatabaseModule } from './db/database.module.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { RedisModule } from './redis/redis.module.js';

@Module({
  imports: [DatabaseModule, CryptoModule, RedisModule, IdempotencyModule, AuthModule, BillingModule],
  controllers: [AppController],
  providers: [AppService, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
