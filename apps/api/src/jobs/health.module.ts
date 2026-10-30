import { Module } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Module({ providers: [HealthService], exports: [HealthService] })
export class HealthModule {}
