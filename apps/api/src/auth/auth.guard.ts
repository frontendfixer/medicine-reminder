import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { ApiException } from '../common/api-exception.js';
import type { AuthedRequest } from '../common/principal.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { authSessions, users } from '../db/schema.js';
import { IS_PUBLIC } from './public.decorator.js';
import { TokensService } from './tokens.service.js';

// Deny by default: a route must be @Public() or carry a valid caregiver access token whose session is still
// the active one (D-019). The session is checked on every request so a replaced or signed-out phone is
// refused at once, not when its 15-minute token runs out.
// Device tokens (`Authorization: Device …`) get their own guard with the pairing work.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw unauthenticated();

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
}

export const unauthenticated = () => new ApiException('UNAUTHENTICATED', 'Sign in to continue.');
export const sessionReplaced = () => new ApiException('SESSION_REPLACED', 'You were signed in on another phone.');
