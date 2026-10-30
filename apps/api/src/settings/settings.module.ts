import { Module } from '@nestjs/common';
import { DosesModule } from '../doses/doses.module.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

@Module({ imports: [DosesModule], controllers: [SettingsController], providers: [SettingsService] })
export class SettingsModule {}
