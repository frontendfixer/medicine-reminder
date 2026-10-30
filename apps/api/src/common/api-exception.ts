import { HttpException } from '@nestjs/common';
import { ERROR_STATUS, type ApiErrorBody, type ErrorCode } from '@med/shared';

// Throw this for every expected failure. The code table is docs/04-api.md#errors.
// `message` is shown to people and may be translated later; never put medicine names, notes or photos in it.
export class ApiException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryAfterSeconds?: number,
  ) {
    const body: ApiErrorBody = { error: { code, message, details } };
    super(body, ERROR_STATUS[code]);
  }

  static validation(fields: Record<string, string>): ApiException {
    return new ApiException('VALIDATION_FAILED', 'The request is not valid.', { fields });
  }
}
