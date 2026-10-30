import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { PatientsModule } from '../patients/patients.module.js';
import { PairingController } from './pairing.controller.js';
import { PairingService } from './pairing.service.js';

@Module({
  imports: [BillingModule, PatientsModule],
  controllers: [PairingController],
  providers: [PairingService],
  exports: [PairingService],
})
export class PairingModule {}
