import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { parse } from '../common/parse.js';
import type { AuthedRequest } from '../common/principal.js';
import { updateSettingsBody } from './settings.dto.js';
import { SettingsService } from './settings.service.js';

@Controller('v1/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(@Req() req: AuthedRequest) {
    return this.settings.get(req.principal!.id);
  }

  @Patch()
  update(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.settings.update(req.principal!.id, parse(updateSettingsBody, body));
  }
}
