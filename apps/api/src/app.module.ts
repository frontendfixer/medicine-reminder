import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { DatabaseModule } from './db/database.module.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';

@Module({
  imports: [DatabaseModule, CryptoModule, IdempotencyModule],
  controllers: [AppController],
  providers: [AppService, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
