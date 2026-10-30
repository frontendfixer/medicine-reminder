import { Module } from '@nestjs/common';
import { PatientsModule } from '../patients/patients.module.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';

@Module({ imports: [PatientsModule], controllers: [DevicesController], providers: [DevicesService], exports: [DevicesService] })
export class DevicesModule {}
