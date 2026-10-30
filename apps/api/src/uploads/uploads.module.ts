import { Module } from '@nestjs/common';
import { PatientsModule } from '../patients/patients.module.js';
import { UploadsController } from './uploads.controller.js';

@Module({ imports: [PatientsModule], controllers: [UploadsController] })
export class UploadsModule {}
