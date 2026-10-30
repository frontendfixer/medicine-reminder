import { randomBytes } from 'node:crypto';
import { PasswordService } from './password.service.js';
import { registerBody } from './auth.dto.js';

function service(pepper = randomBytes(32).toString('base64')) {
  process.env.PASSWORD_PEPPER = pepper;
  return new PasswordService();
}

describe('PasswordService', () => {
  it('hashes with Argon2id at the OWASP minimum parameters (m=19 MiB, t=2, p=1)', async () => {
    const hash = await service().hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain('correct horse');
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const s = service();
    const hash = await s.hash('correct horse battery');
    expect(await s.verify(hash, 'correct horse battery')).toBe(true);
    expect(await s.verify(hash, 'correct horse batterY')).toBe(false);
  });

  it('is useless without the pepper', async () => {
    const pepper = randomBytes(32).toString('base64');
    const hash = await service(pepper).hash('correct horse battery');
    expect(await service(pepper).verify(hash, 'correct horse battery')).toBe(true);
    expect(await service().verify(hash, 'correct horse battery')).toBe(false);
  });

  it('salts every hash', async () => {
    const s = service();
    expect(await s.hash('same password')).not.toBe(await s.hash('same password'));
  });

  it('treats visually identical Unicode as the same password (NFKC) and keeps NUL and emoji', async () => {
    const s = service();
    const hash = await s.hash('ｐａｓｓｗｏｒｄ１２３'); // full-width
    expect(await s.verify(hash, 'password123')).toBe(true);
    const odd = 'pa\0ss😀word';
    expect(await s.verify(await s.hash(odd), odd)).toBe(true);
  });

  it('rejects a short or missing pepper', () => {
    expect(() => service(randomBytes(16).toString('base64'))).toThrow();
    delete process.env.PASSWORD_PEPPER;
    expect(() => new PasswordService()).toThrow();
  });

  it('does the same work for an unknown account', async () => {
    const s = service();
    expect(await s.verifyUnknown('whatever')).toBe(false);
  });
});

describe('registration body', () => {
  const base = { email: 'a@b.co', password: 'longenough', device: { platform: 'android', app_version: '1.0.0' }, consent: { notice_version: '1' } };
  const ok = (over: object) => registerBody.safeParse({ ...base, ...over }).success;

  it('accepts 8 to 128 characters, counted as code points (D-096)', () => {
    expect(ok({ password: 'a'.repeat(7) })).toBe(false);
    expect(ok({ password: 'a'.repeat(8) })).toBe(true);
    expect(ok({ password: 'a'.repeat(128) })).toBe(true);
    expect(ok({ password: 'a'.repeat(129) })).toBe(false);
    expect(ok({ password: '😀'.repeat(8) })).toBe(true); // 8 characters, 16 UTF-16 units
    expect(ok({ password: '😀'.repeat(7) })).toBe(false);
  });

  it('has no composition rules', () => {
    expect(ok({ password: '        ' })).toBe(true);
    expect(ok({ password: '11111111' })).toBe(true);
  });

  it('trims and lower-cases the email and rejects non-emails', () => {
    const parsed = registerBody.parse({ ...base, email: '  Asha@Example.COM ' });
    expect(parsed.email).toBe('asha@example.com');
    expect(ok({ email: 'not-an-email' })).toBe(false);
    expect(ok({ email: '' })).toBe(false);
  });

  it('requires consent and device info', () => {
    expect(ok({ consent: undefined })).toBe(false);
    expect(ok({ device: undefined })).toBe(false);
    expect(ok({ device: { platform: 'windows', app_version: '1' } })).toBe(false);
  });
});
