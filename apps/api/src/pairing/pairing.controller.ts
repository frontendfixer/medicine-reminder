import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { parse } from '../common/parse.js';
import type { AuthedRequest } from '../common/principal.js';
import { SkipIdempotency } from '../idempotency/skip-idempotency.decorator.js';
import { challengeBody, redeemBody } from './pairing.dto.js';
import { PairingService } from './pairing.service.js';

// docs/04-api.md#pairing. challenge and redeem have no signed-in caller and redeem returns a device token,
// so they are exempt from Idempotency-Key (D-098); a lost response is fixed with a new code.
@Controller('v1')
export class PairingController {
  constructor(private readonly pairing: PairingService) {}

  @Post('patients/:patientId/pairing-code')
  createCode(@Param('patientId') patientId: string, @Req() req: AuthedRequest) {
    return this.pairing.createPairingCode(req.principal!.id, patientId);
  }

  @Public()
  @SkipIdempotency()
  @Post('pairing/challenge')
  @HttpCode(200)
  challenge(@Body() body: unknown) {
    return this.pairing.challenge(parse(challengeBody, body).platform);
  }

  @Public()
  @SkipIdempotency()
  @Post('pairing/redeem')
  redeem(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.pairing.redeem(parse(redeemBody, body), req.ip ?? 'unknown');
  }
}
