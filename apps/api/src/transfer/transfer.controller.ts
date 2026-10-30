import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/parse.js';
import type { AuthedRequest } from '../common/principal.js';
import { SkipIdempotency } from '../idempotency/skip-idempotency.decorator.js';
import { TransferService } from './transfer.service.js';

const redeemBody = z.object({ code: z.string({ error: 'is required' }).min(1, { error: 'is required' }).max(32), as_self: z.boolean({ error: 'must be true or false' }) });

@Controller('v1')
export class TransferController {
  constructor(private readonly transfer: TransferService) {}

  @Post('patients/:patientId/transfer-code')
  createCode(@Param('patientId') patientId: string, @Req() req: AuthedRequest) {
    return this.transfer.createCode(req.principal!.id, patientId);
  }

  // Exempt from Idempotency-Key like pairing/redeem (D-098): a code is single-use, so a retry after a lost response
  // gets CODE_EXPIRED_OR_USED, and the patient is already in the receiver's list.
  @SkipIdempotency()
  @Post('transfers/redeem')
  @HttpCode(200)
  redeem(@Body() body: unknown, @Req() req: AuthedRequest) {
    const input = parse(redeemBody, body);
    return this.transfer.redeem(req.principal!.id, input.code, input.as_self);
  }
}
