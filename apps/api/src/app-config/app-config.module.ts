import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppConfigController } from './app-config.controller.js';
import { AppConfigService } from './app-config.service.js';
import { AppVersionGuard } from './app-version.guard.js';

@Global()
@Module({
  controllers: [AppConfigController],
  providers: [AppConfigService, { provide: APP_GUARD, useClass: AppVersionGuard }],
  exports: [AppConfigService],
})
export class AppConfigModule {}
