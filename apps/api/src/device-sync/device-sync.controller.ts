import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { DeviceAuth } from '../auth/auth-scheme.decorator.js';
import { parse } from '../common/parse.js';
import type { AuthedRequest } from '../common/principal.js';
import { SkipIdempotency } from '../idempotency/skip-idempotency.decorator.js';
import { doseResponsesBody, syncQuery } from './device-sync.dto.js';
import { DeviceSyncService } from './device-sync.service.js';
import { DoseResponsesService } from './dose-responses.service.js';

@Controller('v1/device')
@DeviceAuth()
export class DeviceSyncController {
  constructor(
    private readonly sync: DeviceSyncService,
    private readonly responses: DoseResponsesService,
  ) {}

  @Get('sync')
  get(@Query() query: unknown, @Req() req: AuthedRequest) {
    parse(syncQuery, query);
    return this.sync.sync(req.principal!);
  }

  // Idempotent per item by client_event_id, so it needs no Idempotency-Key; answers from every app version are
  // always accepted (D-080).
  @SkipIdempotency()
  @Post('dose-responses')
  @HttpCode(200)
  answer(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.responses.apply(req.principal!, parse(doseResponsesBody, body).responses);
  }
}
