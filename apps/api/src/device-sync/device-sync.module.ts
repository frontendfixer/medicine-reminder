import { Module } from '@nestjs/common';
import { MedicinesModule } from '../medicines/medicines.module.js';
import { DeviceSyncController } from './device-sync.controller.js';
import { DeviceSyncService } from './device-sync.service.js';
import { DoseResponsesService } from './dose-responses.service.js';

@Module({ imports: [MedicinesModule], controllers: [DeviceSyncController], providers: [DeviceSyncService, DoseResponsesService] })
export class DeviceSyncModule {}
