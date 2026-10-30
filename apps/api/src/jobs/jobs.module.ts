import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { DosesModule } from '../doses/doses.module.js';
import { DoseGeneratorService } from './dose-generator.service.js';
import { HealthModule } from './health.module.js';
import { JobsService } from './jobs.service.js';
import { SweeperService } from './sweeper.service.js';

// Services that do the work are always available; JobsService (which starts the BullMQ worker) is added only in the
// worker process, so the API never runs jobs by accident.
@Module({ imports: [DosesModule, HealthModule, BillingModule], providers: [SweeperService, DoseGeneratorService], exports: [SweeperService, DoseGeneratorService, HealthModule, BillingModule] })
export class JobsCoreModule {}

@Module({ imports: [JobsCoreModule], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
