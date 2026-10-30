import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { parse } from '../common/parse.js';
import type { AuthedRequest } from '../common/principal.js';
import { adherenceQuery, auditQuery, dosesQuery } from './history.dto.js';
import { HistoryService } from './history.service.js';

@Controller('v1/patients/:patientId')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get('doses')
  doses(@Param('patientId') id: string, @Query() q: unknown, @Req() req: AuthedRequest) {
    return this.history.doses(req.principal!.id, id, parse(dosesQuery, q));
  }

  @Get('adherence')
  adherence(@Param('patientId') id: string, @Query() q: unknown, @Req() req: AuthedRequest) {
    return this.history.adherence(req.principal!.id, id, parse(adherenceQuery, q));
  }

  @Get('audit-log')
  auditLog(@Param('patientId') id: string, @Query() q: unknown, @Req() req: AuthedRequest) {
    return this.history.auditLog(req.principal!.id, id, parse(auditQuery, q));
  }
}
