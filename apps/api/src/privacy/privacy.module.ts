import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrivacyController } from './privacy.controller.js';
import { PrivacyService } from './privacy.service.js';

@Module({ imports: [AuthModule], controllers: [PrivacyController], providers: [PrivacyService] })
export class PrivacyModule {}
