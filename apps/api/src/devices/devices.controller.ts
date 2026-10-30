import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { AnyAuth } from '../auth/auth-scheme.decorator.js';
import { parse } from '../common/parse.js';
import type { AuthedRequest } from '../common/principal.js';
import { SkipIdempotency } from '../idempotency/skip-idempotency.decorator.js';
import { heartbeatBody } from './devices.dto.js';
import { DevicesService } from './devices.service.js';

@Controller('v1')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get('patients/:patientId/devices')
  list(@Param('patientId') patientId: string, @Req() req: AuthedRequest) {
    return this.devices.listForPatient(req.principal!.id, patientId);
  }

  @Post('devices/:deviceId/revoke')
  @HttpCode(200)
  revoke(@Param('deviceId') deviceId: string, @Req() req: AuthedRequest) {
    return this.devices.revoke(req.principal!.id, deviceId);
  }

  // Caregiver or device. Exempt from Idempotency-Key: it is repeatable by nature, the response (server time,
  // sync_needed) must be fresh, never replayed, and builds below the minimum version must still be accepted (D-080).
  @AnyAuth()
  @SkipIdempotency()
  @Post('devices/heartbeat')
  @HttpCode(200)
  heartbeat(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.devices.heartbeat(req.principal!, parse(heartbeatBody, body));
  }
}
