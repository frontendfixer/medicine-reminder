import { type ArgumentsHost, BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { ApiException } from './api-exception.js';
import { ApiExceptionFilter } from './api-exception.filter.js';

function run(exception: unknown) {
  const sent: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res = {
    setHeader: (k: string, v: string) => void (sent.headers[k] = v),
    status: (s: number) => ((sent.status = s), res),
    json: (b: unknown) => void (sent.body = b),
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new ApiExceptionFilter().catch(exception, host);
  return sent;
}

describe('ApiExceptionFilter', () => {
  it('renders an ApiException with its status, code and details', () => {
    const out = run(new ApiException('PATIENT_LIMIT_REACHED', 'Your plan allows 3 patients.', { limit: 3 }));
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ error: { code: 'PATIENT_LIMIT_REACHED', message: 'Your plan allows 3 patients.', details: { limit: 3 } } });
  });

  it('lists invalid fields for VALIDATION_FAILED', () => {
    const out = run(ApiException.validation({ email: 'required' }));
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ error: { code: 'VALIDATION_FAILED', details: { fields: { email: 'required' } } } });
  });

  it('sets Retry-After on rate limits', () => {
    const out = run(new ApiException('RATE_LIMITED', 'Slow down.', {}, 30));
    expect(out.status).toBe(429);
    expect(out.headers['Retry-After']).toBe('30');
  });

  it('maps Nest HTTP exceptions onto the same format without echoing their messages', () => {
    expect(run(new NotFoundException('Cannot GET /secret-route')).body).toMatchObject({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    expect(run(new ForbiddenException()).status).toBe(403);
    expect(run(new BadRequestException('Unexpected token in JSON')).body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('hides unexpected errors behind INTERNAL', () => {
    for (const e of [new Error('password=hunter2 for Metformin'), new HttpException('teapot', 418), 'boom']) {
      const out = run(e);
      expect(out.status).toBe(500);
      expect(JSON.stringify(out.body)).not.toMatch(/hunter2|Metformin|teapot|boom/);
      expect(out.body).toMatchObject({ error: { code: 'INTERNAL' } });
    }
  });
});
