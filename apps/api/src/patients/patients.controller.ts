import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { AuthedRequest } from '../common/principal.js';
import { parse } from '../common/parse.js';
import { createPatientBody, listPatientsQuery, updatePatientBody } from './patients.dto.js';
import { PatientsService } from './patients.service.js';

// docs/04-api.md#patients. The caregiver is always `req.principal.id`; the path only names which of
// *their own* patients is meant.
@Controller('v1/patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Post()
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.patients.create(req.principal!.id, parse(createPatientBody, body));
  }

  @Get()
  list(@Query() query: unknown, @Req() req: AuthedRequest) {
    return this.patients.list(req.principal!.id, parse(listPatientsQuery, query).status);
  }

  @Get(':patientId')
  get(@Param('patientId') patientId: string, @Req() req: AuthedRequest) {
    return this.patients.get(req.principal!.id, patientId);
  }

  @Patch(':patientId')
  update(@Param('patientId') patientId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.patients.update(req.principal!.id, patientId, parse(updatePatientBody, body));
  }

  @Post(':patientId/archive')
  @HttpCode(200)
  archive(@Param('patientId') patientId: string, @Req() req: AuthedRequest) {
    return this.patients.archive(req.principal!.id, patientId);
  }

  @Post(':patientId/reactivate')
  @HttpCode(200)
  reactivate(@Param('patientId') patientId: string, @Req() req: AuthedRequest) {
    return this.patients.reactivate(req.principal!.id, patientId);
  }
}
