import { randomBytes } from 'node:crypto';
import { Hmac } from './hmac.js';

describe('Hmac', () => {
  const hmac = new Hmac(randomBytes(32));

  it('is deterministic and keyed', () => {
    expect(hmac.hex('a', 'b')).toBe(hmac.hex('a', 'b'));
    expect(hmac.hex('a', 'b')).not.toBe(new Hmac(randomBytes(32)).hex('a', 'b'));
  });

  it('does not confuse part boundaries', () => {
    expect(hmac.hex('ab', 'c')).not.toBe(hmac.hex('a', 'bc'));
    expect(hmac.hex('a')).not.toBe(hmac.hex('a', ''));
  });

  it('rejects a short or missing pepper', () => {
    expect(() => new Hmac(randomBytes(16))).toThrow();
    expect(() => Hmac.fromEnv({})).toThrow();
  });
});
