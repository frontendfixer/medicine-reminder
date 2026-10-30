import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { AppConfigModule } from './app-config/app-config.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { DatabaseModule } from './db/database.module.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { DeviceSyncModule } from './device-sync/device-sync.module.js';
import { DevicesModule } from './devices/devices.module.js';
import { HistoryModule } from './history/history.module.js';
import { MedicinesModule } from './medicines/medicines.module.js';
import { PairingModule } from './pairing/pairing.module.js';
import { PatientsModule } from './patients/patients.module.js';
import { StorageModule } from './storage/storage.module.js';
import { TransferModule } from './transfer/transfer.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { PrivacyModule } from './privacy/privacy.module.js';
import { RedisModule } from './redis/redis.module.js';

@Module({
  imports: [DatabaseModule, CryptoModule, RedisModule, IdempotencyModule, AuthModule, BillingModule, AuditModule, PatientsModule, PairingModule, DevicesModule, AppConfigModule, MedicinesModule, SettingsModule, StorageModule, UploadsModule, DeviceSyncModule, HistoryModule, TransferModule, PrivacyModule],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
