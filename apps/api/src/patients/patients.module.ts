import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { PatientsController } from './patients.controller.js';
import { PatientsRepository } from './patients.repository.js';
import { PatientsService } from './patients.service.js';

@Module({
  imports: [BillingModule],
  controllers: [PatientsController],
  providers: [PatientsService, PatientsRepository],
  exports: [PatientsRepository],
})
export class PatientsModule {}
