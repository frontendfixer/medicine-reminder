import { createHmac } from 'node:crypto';

// Keyed hashes for values that must not be guessable offline (request bodies, pairing codes, device tokens).
// The pepper comes from the secret manager (docs/10-security-privacy.md, Secrets).
export class Hmac {
  constructor(private readonly pepper: Buffer) {
    if (pepper.length < 32) throw new Error('HMAC_PEPPER must be at least 32 bytes (base64)');
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): Hmac {
    if (!env.HMAC_PEPPER) throw new Error('HMAC_PEPPER is required');
    return new Hmac(Buffer.from(env.HMAC_PEPPER, 'base64'));
  }

  // Parts are length-prefixed so ("ab","c") and ("a","bc") never collide.
  hex(...parts: string[]): string {
    const mac = createHmac('sha256', this.pepper);
    for (const part of parts) {
      const bytes = Buffer.from(part, 'utf8');
      mac.update(`${bytes.length}:`);
      mac.update(bytes);
    }
    return mac.digest('hex');
  }
}
