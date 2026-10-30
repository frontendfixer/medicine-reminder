import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Hmac } from '../crypto/hmac.js';

const ISSUER = 'medicine-reminder-api';
const AUDIENCE = 'medicine-reminder-app';
export const ACCESS_TTL_SECONDS = 15 * 60; // docs/04-api.md#auth (suggested)
export const REFRESH_TTL_DAYS = 90; // sliding: each refresh extends it; an unused session expires after this

export interface AccessClaims {
  sub: string; // users.id
  sid: string; // auth_sessions.id
}

@Injectable()
export class TokensService {
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly hmac: Hmac,
  ) {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret || Buffer.from(secret, 'base64').length < 32) {
      throw new Error('JWT_ACCESS_SECRET is required and must be at least 32 bytes (base64)');
    }
    this.secret = secret;
  }

  signAccess(claims: AccessClaims): Promise<string> {
    return this.jwt.signAsync(claims, {
      secret: this.secret,
      algorithm: 'HS256',
      expiresIn: ACCESS_TTL_SECONDS,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  }

  // Throws on a bad signature, wrong algorithm, wrong issuer/audience or expiry.
  verifyAccess(token: string): Promise<AccessClaims> {
    return this.jwt.verifyAsync<AccessClaims>(token, {
      secret: this.secret,
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  }

  // Opaque and random. Only a keyed hash is stored, so a database leak yields no usable refresh tokens.
  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashRefresh(token) };
  }

  // A patient-device token, hashed exactly as pairing hashes them (PairingService.hashDeviceToken).
  newDeviceToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hmac.hex('device-token', token) };
  }

  hashRefresh(token: string): string {
    return this.hmac.hex('refresh-token', token);
  }
}
