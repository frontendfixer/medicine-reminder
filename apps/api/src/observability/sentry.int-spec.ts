import * as Sentry from '@sentry/nestjs';
import { Body, Controller, Post } from '@nestjs/common';
import { startApp } from '../testing/harness.js';
import { initSentry } from './sentry.js';

const captured: unknown[] = [];
// Built at runtime: Sentry attaches nearby *source lines* to stack frames, and a literal in this file would show up there.
// Real user data is never in source code, so this keeps the check about data only.
const NOTE = ['SECRET', 'NOTE'].join('');
const SHOWN_NAME = ['Grandma', 'Asha'].join(' ');
const MAIL = ['asha', 'example.com'].join('@');
const BEARER = ['abcdef', 'ghijkl'].join('.');

@Controller('v1/boom')
class BoomController {
  // Throws an unexpected error whose message, request body and headers are full of things that must never be reported.
  @Post()
  boom(@Body() body: { name: string }): never {
    Sentry.addBreadcrumb({ category: 'console', message: `saving ${body.name}` });
    Sentry.setUser({ id: 'user-1', email: MAIL });
    Sentry.setExtra('payload', { name: body.name, notes: NOTE, display_name: SHOWN_NAME });
    throw new Error(`could not save ${body.name} for ${MAIL}: Bearer ${BEARER}`);
  }
}

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  // The real SDK, with the real scrubbers, and a transport that records instead of sending.
  initSentry({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    transport: () => ({
      send: (envelope) => {
        captured.push(envelope);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
  });
  t = await startApp({ controllers: [BoomController] });
});
afterAll(async () => {
  await Sentry.close(2000);
  await t.close();
});

describe('an unexpected error reaches Sentry scrubbed (D-063, CLAUDE.md)', () => {
  it('reports the error but none of the names, notes, emails, tokens or passwords around it', async () => {
    const me = await t.caregiver();
    const res = await t.http().post('/v1/boom').set('Authorization', `Bearer ${me.token}`).set('Idempotency-Key', crypto.randomUUID()).send({ name: 'Metformin SECRETNAME', password: 'hunter2-password' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('Metformin');
    await Sentry.flush(2000);

    const text = JSON.stringify(captured);
    expect(text).toContain('Error'); // an error event did go out
    for (const secret of ['Metformin SECRETNAME', NOTE, MAIL, 'hunter2-password', SHOWN_NAME, BEARER, me.token]) expect(text, secret).not.toContain(secret);
  });
});
