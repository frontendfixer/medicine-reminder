import { Module } from '@nestjs/common';
import { DosesModule } from '../doses/doses.module.js';
import { PatientsModule } from '../patients/patients.module.js';
import { MedicinesController } from './medicines.controller.js';
import { MedicinesRepository } from './medicines.repository.js';
import { MedicinesService } from './medicines.service.js';

@Module({
  imports: [DosesModule, PatientsModule],
  controllers: [MedicinesController],
  providers: [MedicinesService, MedicinesRepository],
  exports: [MedicinesRepository],
})
export class MedicinesModule {}
