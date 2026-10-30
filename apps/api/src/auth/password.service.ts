import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// Argon2id at the OWASP minimum (R-47): m = 19 MiB, t = 2, p = 1. The PHC string carries these parameters,
// so they can be raised later and old hashes keep verifying.
// `algorithm: 2` is Argon2id (the library's const enum can't be imported under isolatedModules); a test checks it.
const PARAMS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// docs/10-security-privacy.md (Auth hardening), D-095, D-096.
@Injectable()
export class PasswordService {
  private readonly secret: Buffer;
  private dummyHash?: Promise<string>;

  constructor() {
    const pepper = process.env.PASSWORD_PEPPER;
    if (!pepper) throw new Error('PASSWORD_PEPPER is required');
    this.secret = Buffer.from(pepper, 'base64');
    if (this.secret.length < 32) throw new Error('PASSWORD_PEPPER must be at least 32 bytes (base64)');
  }

  // The pepper is Argon2's optional secret value K (RFC 9106 section 3.1). It is not stored with the hash, so
  // losing it makes every password unverifiable, and v1 has no password reset (D-096): back it up.
  // NFKC so the same visible password hashes the same on every keyboard; nothing is truncated.
  hash(password: string): Promise<string> {
    return hash(password.normalize('NFKC'), { ...PARAMS, secret: this.secret });
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    return verify(passwordHash, password.normalize('NFKC'), { secret: this.secret });
  }

  // For unknown emails: do the same work as a real check so timing doesn't reveal whether the account exists.
  async verifyUnknown(password: string): Promise<false> {
    this.dummyHash ??= this.hash('dummy password for timing equalisation');
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
