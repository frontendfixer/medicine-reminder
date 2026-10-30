import { scrubBreadcrumb, scrubEvent, scrubText } from './scrub.js';

const SECRETS = ['Metformin SECRETNAME', 'SECRETNOTE', 'asha@example.com', 'hunter2-password', 'Grandma Asha', 'ABCD-2345', '2 tablets SECRETAMT', 'photo/p1/m/abc.jpg'];
const expectClean = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
  expect(text).not.toMatch(/Bearer [A-Za-z0-9]|ExponentPushToken\[[^F]|\$argon2id|eyJhbGci|Device [A-Za-z0-9_-]{20}/);
};

const dirty = {
  event_id: 'abc',
  level: 'error',
  release: '1.2.3',
  message: 'Failed for asha@example.com with code ABCD-2345',
  user: { id: 'u-1', email: 'asha@example.com', ip_address: '1.2.3.4', username: 'Grandma Asha' },
  request: {
    method: 'POST',
    url: 'https://api.example.com/v1/patients/p1/medicines?name=Metformin%20SECRETNAME',
    query_string: 'name=Metformin SECRETNAME',
    data: { name: 'Metformin SECRETNAME', notes: 'SECRETNOTE', password: 'hunter2-password' },
    cookies: { session: 'abc' },
    headers: { authorization: 'Bearer abcdef.ghijkl', cookie: 's=1', 'user-agent': 'x' },
  },
  extra: { body: { name: 'Metformin SECRETNAME' }, display_name: 'Grandma Asha', amount_text: '2 tablets SECRETAMT', photo_object_key: 'photo/p1/m/abc.jpg', retries: 3, nested: { deep: { push_token: 'ExponentPushToken[xyz]', fine: 1 } } },
  contexts: { app: { app_name: 'api' }, device: { token: 'secret' } },
  tags: { route: '/v1/medicines', email: 'asha@example.com' },
  breadcrumbs: [
    { category: 'console', message: 'Metformin SECRETNAME was saved' },
    { category: 'http', message: 'POST /v1/auth/login hunter2-password', data: { url: 'https://x/y?token=1', status_code: 500, body: 'Metformin SECRETNAME' } },
  ],
  exception: {
    values: [
      {
        type: 'DrizzleQueryError',
        value: 'Failed query: insert into "medicines" ("name") values ($1)\nparams: Metformin SECRETNAME,asha@example.com,$argon2id$v=19$m=19456,t=2,p=1$abc$def',
        stacktrace: { frames: [{ filename: 'a.ts', lineno: 3, function: 'save', vars: { name: 'Metformin SECRETNAME' } }] },
      },
      { type: 'Error', value: 'auth failed: Bearer abcdef.ghijkl and Device AAAAAAAAAAAAAAAAAAAAAAAA and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' },
    ],
  },
};

describe('scrubEvent', () => {
  it('removes every planted name, note, email, password, token and code', () => {
    expectClean(scrubEvent(dirty));
  });

  it('drops request bodies, headers, cookies and query strings, keeping only the method and path', () => {
    const out = scrubEvent(dirty) as typeof dirty;
    expect(out.request).toEqual({ method: 'POST', url: 'https://api.example.com/v1/patients/p1/medicines' });
  });

  it('identifies people by internal ID only', () => {
    expect((scrubEvent(dirty) as typeof dirty).user).toEqual({ id: 'u-1' });
  });

  it('keeps what is needed to debug: ids, level, release, error types, files and lines, harmless extras', () => {
    const out = scrubEvent(dirty) as typeof dirty;
    expect(out).toMatchObject({ event_id: 'abc', level: 'error', release: '1.2.3' });
    expect(out.exception.values[0]).toMatchObject({ type: 'DrizzleQueryError', value: '[Filtered message]' });
    expect(out.exception.values[0]!.stacktrace!.frames[0]).toEqual({ filename: 'a.ts', lineno: 3, function: 'save' }); // local variables gone
    expect(out.extra.retries).toBe(3);
    expect(out.extra.nested.deep).toMatchObject({ fine: 1 });
    expect(out.contexts.app).toEqual({ app_name: 'api' });
    expect(out.tags.route).toBe('/v1/medicines');
  });

  it('removes console breadcrumbs entirely and cleans the rest', () => {
    const out = scrubEvent(dirty) as typeof dirty;
    expect(out.breadcrumbs).toHaveLength(1);
    expect(out.breadcrumbs[0]).toMatchObject({ category: 'http' });
    expect(JSON.stringify(out.breadcrumbs)).not.toContain('hunter2');
  });

  it('is safe on empty events and does not modify its input', () => {
    expect(() => scrubEvent({})).not.toThrow();
    const copy = JSON.stringify(dirty);
    scrubEvent(dirty);
    expect(JSON.stringify(dirty)).toBe(copy);
  });
});

describe('scrubText / scrubBreadcrumb', () => {
  it('keeps only system-error messages, which carry no data', () => {
    const msg = (value: string) => (scrubEvent({ exception: { values: [{ type: 'Error', value }] } }) as { exception: { values: { value: string }[] } }).exception.values[0]!.value;
    expect(msg('connect ECONNREFUSED 127.0.0.1:5432')).toBe('connect ECONNREFUSED 127.0.0.1:5432');
    expect(msg('could not save Metformin for Asha')).toBe('[Filtered message]');
    expect(msg('')).toBe('[Filtered message]');
  });
  it('cuts database parameters and masks secrets in free text', () => {
    expect(scrubText('Failed query: select 1\nparams: a,b,c')).toBe('Failed query: select 1\nparams: [Filtered]');
    expect(scrubText('mail asha@example.com')).toBe('mail [Filtered email]');
    expect(scrubText('v1:dev1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBB')).toBe('[Filtered ciphertext]');
  });
  it('drops console crumbs and filters data keys', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'http', data: { url: 'https://x', method: 'GET' } })).toEqual({ category: 'http', data: { url: '[Filtered]', method: 'GET' } });
  });
});
