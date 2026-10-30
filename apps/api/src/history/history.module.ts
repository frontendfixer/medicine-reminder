import { Module } from '@nestjs/common';
import { PatientsModule } from '../patients/patients.module.js';
import { HistoryController } from './history.controller.js';
import { HistoryService } from './history.service.js';

@Module({ imports: [PatientsModule], controllers: [HistoryController], providers: [HistoryService] })
export class HistoryModule {}
