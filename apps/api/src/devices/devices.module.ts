import { Module } from '@nestjs/common';
import { DosesModule } from '../doses/doses.module.js';
import { PatientsModule } from '../patients/patients.module.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';

@Module({ imports: [PatientsModule, DosesModule], controllers: [DevicesController], providers: [DevicesService], exports: [DevicesService] })
export class DevicesModule {}
