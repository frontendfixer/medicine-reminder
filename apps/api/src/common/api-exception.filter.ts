import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ERROR_STATUS, type ApiErrorBody, type ErrorCode } from '@med/shared';
import type { Response } from 'express';
import { ApiException } from './api-exception.js';

// Plain HTTP exceptions (unknown route, malformed JSON, guards) map onto the same error format.
type MappedCode = 'VALIDATION_FAILED' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED';
const CODE_BY_STATUS: Record<number, MappedCode | undefined> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
};

const GENERIC_MESSAGE: Record<MappedCode | 'INTERNAL', string> = {
  VALIDATION_FAILED: 'The request is not valid.',
  UNAUTHENTICATED: 'Sign in to continue.',
  FORBIDDEN: 'You cannot do that.',
  NOT_FOUND: 'Not found.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  INTERNAL: 'Something went wrong.',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ApiException) {
      if (exception.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(exception.retryAfterSeconds));
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_STATUS[status];
      if (code) {
        res.status(status).json(body(code, GENERIC_MESSAGE[code]));
        return;
      }
    }

    // Anything else is a bug. Log the class only: messages and stacks can carry request data.
    this.logger.error(`Unhandled ${exception instanceof Error ? exception.constructor.name : typeof exception}`);
    res.status(ERROR_STATUS.INTERNAL).json(body('INTERNAL', GENERIC_MESSAGE.INTERNAL));
  }
}

function body(code: ErrorCode, message: string): ApiErrorBody {
  return { error: { code, message, details: {} } };
}
