import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { AppConfigService } from './app-config.service.js';

@Controller('v1/app')
export class AppConfigController {
  constructor(private readonly config: AppConfigService) {}

  @Public()
  @Get('config')
  get() {
    return this.config.get();
  }
}
