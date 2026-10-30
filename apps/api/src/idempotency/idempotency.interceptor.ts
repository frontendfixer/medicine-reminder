import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, Logger } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { ApiErrorBody } from '@med/shared';
import type { Response } from 'express';
import { catchError, defer, from, mergeMap, type Observable, of, throwError } from 'rxjs';
import { ApiException } from '../common/api-exception.js';
import type { AuthedRequest } from '../common/principal.js';
import { Hmac } from '../crypto/hmac.js';
import { canonicalJson } from './canonical-json.js';
import { SKIP_IDEMPOTENCY } from './skip-idempotency.decorator.js';
import { IdempotencyStore } from './idempotency.store.js';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Transient outcomes: a retry with the same key must run again.
const NOT_STORED = new Set([408, 425, 429]);

// docs/04-api.md#idempotency, D-058, D-083.
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly store: IdempotencyStore,
    private readonly hmac: Hmac,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    if (!WRITE_METHODS.has(req.method)) return next.handle();
    if (this.reflector.getAllAndOverride<boolean>(SKIP_IDEMPOTENCY, [context.getHandler(), context.getClass()])) return next.handle();

    const key = req.header('idempotency-key');
    if (!key || !UUID.test(key)) {
      throw ApiException.validation({ 'Idempotency-Key': key ? 'must be a UUID' : 'is required' });
    }
    const principal = req.principal;
    if (!principal) {
      // A write with no caller can't be scoped. Fail closed; mark the route @SkipIdempotency() on purpose.
      this.logger.error(`No principal on ${req.method} ${req.route?.path ?? '?'}`);
      throw new ApiException('INTERNAL', 'Something went wrong.');
    }

    const path = (req.originalUrl ?? req.url).split('?')[0]!;
    const methodPath = `${req.method} ${path}`;
    const requestHash = this.hmac.hex(methodPath, (req.originalUrl ?? '').split('?')[1] ?? '', canonicalJson(req.body));
    const res = http.getResponse<Response>();

    const claim = await this.store.claim(principal.id, key, methodPath, requestHash);
    switch (claim.kind) {
      case 'conflict':
        throw new ApiException('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
      case 'in_progress':
        throw new ApiException('REQUEST_IN_PROGRESS', 'The first request is still being processed. Retry shortly.', {}, 1);
      case 'replay': {
        res.setHeader('Idempotent-Replayed', 'true');
        if (claim.status >= 400) {
          const { error } = claim.body as ApiErrorBody;
          throw new ApiException(error.code, error.message, error.details);
        }
        return of(claim.body); // Nest applies the same status as the first response
      }
      case 'claimed':
        break;
    }

    const successStatus = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ?? (req.method === 'POST' ? 201 : 200);
    return next.handle().pipe(
      mergeMap((body) => from(this.store.complete(principal.id, key, successStatus, body).then(() => body))),
      catchError((err: unknown) =>
        defer(async () => {
          if (err instanceof ApiException && err.getStatus() >= 400 && err.getStatus() < 500 && !NOT_STORED.has(err.getStatus())) {
            await this.store.complete(principal.id, key, err.getStatus(), err.getResponse());
          } else {
            await this.store.release(principal.id, key);
          }
        }).pipe(mergeMap(() => throwError(() => err))),
      ),
    );
  }
}
