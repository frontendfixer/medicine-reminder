import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { parse } from '../common/parse.js';
import type { AuthedRequest } from '../common/principal.js';
import { createMedicineBody, listMedicinesQuery, updateMedicineBody } from './medicines.dto.js';
import { MedicinesService } from './medicines.service.js';

@Controller('v1')
export class MedicinesController {
  constructor(private readonly medicines: MedicinesService) {}

  @Get('patients/:patientId/medicines')
  list(@Param('patientId') patientId: string, @Query() query: unknown, @Req() req: AuthedRequest) {
    return this.medicines.list(req.principal!.id, patientId, parse(listMedicinesQuery, query).include_archived === 'true');
  }

  @Post('patients/:patientId/medicines')
  create(@Param('patientId') patientId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.medicines.create(req.principal!.id, patientId, parse(createMedicineBody, body));
  }

  @Get('medicines/:medicineId')
  get(@Param('medicineId') medicineId: string, @Req() req: AuthedRequest) {
    return this.medicines.get(req.principal!.id, medicineId);
  }

  @Patch('medicines/:medicineId')
  update(@Param('medicineId') medicineId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.medicines.update(req.principal!.id, medicineId, parse(updateMedicineBody, body));
  }

  @Post('medicines/:medicineId/archive')
  @HttpCode(200)
  archive(@Param('medicineId') medicineId: string, @Req() req: AuthedRequest) {
    return this.medicines.archive(req.principal!.id, medicineId);
  }

  // Stock counts are v1.1 (D-070). The route exists behind the feature flag and is a 404 until then.
  @Patch('medicines/:medicineId/stock')
  stock(): never {
    throw new ApiException('NOT_FOUND', 'Not found.');
  }
}
