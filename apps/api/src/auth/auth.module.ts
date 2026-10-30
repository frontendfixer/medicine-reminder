import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { BillingModule } from '../billing/billing.module.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { LoginThrottle } from './login-throttle.js';
import { PasswordService } from './password.service.js';
import { TokensService } from './tokens.service.js';

// Needs DatabaseModule, CryptoModule and RedisModule (all global).
@Module({
  imports: [JwtModule.register({}), BillingModule], // the secret is passed per call by TokensService
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokensService, LoginThrottle, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
