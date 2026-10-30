import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { DatabaseModule } from './db/database.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { PushModule } from './push/push.module.js';

// The worker process (docs/02-architecture.md#processes): jobs only, no HTTP.
@Module({ imports: [DatabaseModule, CryptoModule, AuditModule, PushModule, JobsModule] })
export class WorkerModule {}
