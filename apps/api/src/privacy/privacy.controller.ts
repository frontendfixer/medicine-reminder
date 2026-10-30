import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/parse.js';
import type { AuthedRequest } from '../common/principal.js';
import { PrivacyService } from './privacy.service.js';

const deleteBody = z.object({ confirm: z.literal('DELETE', { error: 'must be DELETE' }), password: z.string({ error: 'is required' }).min(1, { error: 'is required' }).max(1024) });

@Controller('v1/me')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Post('export')
  @HttpCode(202)
  export(@Req() req: AuthedRequest) {
    return this.privacy.requestExport(req.principal!.id);
  }

  @Get('export/:requestId')
  getExport(@Param('requestId') requestId: string, @Req() req: AuthedRequest) {
    return this.privacy.getExport(req.principal!.id, requestId);
  }

  @Post('delete')
  @HttpCode(202)
  delete(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.privacy.deleteAccount(req.principal!.id, parse(deleteBody, body).password);
  }
}
