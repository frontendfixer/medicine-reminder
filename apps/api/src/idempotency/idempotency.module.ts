import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyStore } from './idempotency.store.js';

// Needs DatabaseModule and CryptoModule (both global).
@Module({
  providers: [IdempotencyStore, { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
})
export class IdempotencyModule {}
