import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { AuthedRequest } from '../common/principal.js';
import { parse } from '../common/parse.js';
import { SkipIdempotency } from '../idempotency/skip-idempotency.decorator.js';
import { loginBody, refreshBody, registerBody } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';

// docs/04-api.md#auth. auth/* is exempt from Idempotency-Key: responses carry tokens, and sign-in is
// naturally repeatable.
@Controller('v1/auth')
@SkipIdempotency()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.auth.register(parse(registerBody, body), req.ip ?? 'unknown');
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.auth.login(parse(loginBody, body), req.ip ?? 'unknown');
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown) {
    return this.auth.refresh(parse(refreshBody, body).refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest): Promise<void> {
    await this.auth.logout(req.principal!.sessionId!);
  }
}
