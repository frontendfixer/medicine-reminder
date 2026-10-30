import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { HealthModule } from '../jobs/health.module.js';
import { PairingModule } from '../pairing/pairing.module.js';
import { PatientsModule } from '../patients/patients.module.js';
import { TransferController } from './transfer.controller.js';
import { TransferService } from './transfer.service.js';

@Module({ imports: [BillingModule, PairingModule, PatientsModule, HealthModule], controllers: [TransferController], providers: [TransferService] })
export class TransferModule {}
