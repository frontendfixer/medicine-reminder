import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-exception.js';
import type { AuthedRequest } from '../common/principal.js';
import { Hmac } from '../crypto/hmac.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { authSessions, devices, notificationLog, patients, users } from '../db/schema.js';
import { REDIS } from '../redis/redis.constants.js';
import { AUTH_SCHEME, type AuthScheme } from './auth-scheme.decorator.js';
import { IS_PUBLIC } from './public.decorator.js';
import { TokensService } from './tokens.service.js';

const REJECTED_ALERT_SECONDS = 12 * 3600; // 06: at most one alert per device per 12 h

// Deny by default: a route is @Public(), or needs a caregiver access token (default), a paired-device token
// (@DeviceAuth) or either (@AnyAuth).
// Caregiver tokens are checked against their session on every request so a replaced or signed-out phone is
// refused at once (D-019). Device tokens are looked up by keyed hash and refused once revoked (D-015).
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly hmac: Hmac,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const scheme = this.reflector.getAllAndOverride<AuthScheme>(AUTH_SCHEME, targets) ?? 'caregiver';

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const bearer = /^Bearer (\S+)$/i.exec(header)?.[1];
    const device = /^Device (\S+)$/i.exec(header)?.[1];

    if (bearer && scheme !== 'device') return this.caregiver(req, bearer);
    if (device && scheme !== 'caregiver') return this.device(req, device);
    throw unauthenticated();
  }

  private async caregiver(req: AuthedRequest, token: string): Promise<boolean> {
    const claims = await this.tokens.verifyAccess(token).catch(() => null);
    if (!claims || typeof claims.sub !== 'string' || typeof claims.sid !== 'string') throw unauthenticated();

    const [row] = await this.db
      .select({ revokedAt: authSessions.revokedAt, revokedReason: authSessions.revokedReason, deletedAt: users.deletedAt })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(and(eq(authSessions.id, claims.sid), eq(authSessions.userId, claims.sub)));
    if (!row || row.deletedAt) throw unauthenticated();
    if (row.revokedAt) throw row.revokedReason === 'replaced' ? sessionReplaced() : unauthenticated();

    req.principal = { type: 'caregiver', id: claims.sub, sessionId: claims.sid };
    return true;
  }

  private async device(req: AuthedRequest, token: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: devices.id, patientId: devices.patientId, revokedAt: devices.revokedAt, ownerUserId: patients.ownerUserId })
      .from(devices)
      .innerJoin(patients, eq(patients.id, devices.patientId))
      .where(eq(devices.tokenHash, this.hmac.hex('device-token', token)));
    if (!row || !row.patientId) throw deviceRejected();
    if (row.revokedAt) {
      await this.alertCaregiver(row.id, row.patientId, row.ownerUserId);
      throw deviceRejected();
    }
    req.principal = { type: 'device', id: row.id, patientId: row.patientId };
    return true;
  }

  // First time a revoked phone calls in: tell the caregiver (kind `pairing`), at most once per 12 h per device.
  private async alertCaregiver(deviceId: string, patientId: string, ownerUserId: string): Promise<void> {
    const first = await this.redis.set(`rejected:${deviceId}`, '1', 'EX', REJECTED_ALERT_SECONDS, 'NX').catch(() => null);
    if (first !== 'OK') return;
    await this.db.transaction(async (tx) => {
      const targets = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, ownerUserId), isNull(devices.revokedAt)));
      if (targets.length) await tx.insert(notificationLog).values(targets.map((t) => ({ kind: 'pairing' as const, patientId, deviceId: t.id, data: { event: 'token_rejected', device_id: deviceId } })));
      await this.audit.record(tx, { actorType: 'system', patientId, action: 'device.token_rejected', targetType: 'device', targetId: deviceId });
    });
  }
}

export const unauthenticated = () => new ApiException('UNAUTHENTICATED', 'Sign in to continue.');
export const sessionReplaced = () => new ApiException('SESSION_REPLACED', 'You were signed in on another phone.');
export const deviceRejected = () => new ApiException('DEVICE_TOKEN_REJECTED', 'This phone is no longer connected. Ask your caregiver for a new code.');
