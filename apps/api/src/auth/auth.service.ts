import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ApiException } from '../common/api-exception.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { authSessions, caregiverSettings, consents, devices, users } from '../db/schema.js';
import { RateLimiter } from '../redis/rate-limiter.js';
import type { DeviceInfo, LoginBody, RegisterBody } from './auth.dto.js';
import { sessionReplaced, unauthenticated } from './auth.guard.js';
import { LoginThrottle } from './login-throttle.js';
import { PasswordService } from './password.service.js';
import { REFRESH_TTL_DAYS, TokensService } from './tokens.service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Per-IP limits (suggested; docs/04-api.md#auth). Per-account delays are in LoginThrottle.
const LOGIN_PER_IP = { limit: 30, windowMs: 10 * 60_000 };
const REGISTER_PER_IP = { limit: 10, windowMs: 60 * 60_000 };

export interface AuthResult {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
  session_replaced_previous: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly passwords: PasswordService,
    private readonly tokens: TokensService,
    private readonly throttle: LoginThrottle,
    private readonly limiter: RateLimiter,
  ) {}

  async register(body: RegisterBody, ip: string): Promise<AuthResult> {
    await this.limiter.hit(`register:ip:${ip}`, REGISTER_PER_IP.limit, REGISTER_PER_IP.windowMs);
    const passwordHash = await this.passwords.hash(body.password);
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email: body.email, passwordHash }).returning({ id: users.id, email: users.email });
        await tx.insert(caregiverSettings).values({ userId: user!.id }); // defaults: 30 min, full, false
        await tx.insert(consents).values({ subjectType: 'caregiver', userId: user!.id, kind: 'signup', noticeVersion: body.consent.notice_version });
        return this.startSession(tx, user!, body.device);
      });
    } catch (e) {
      if (violates(e, 'users_email_uq')) throw new ApiException('EMAIL_TAKEN', 'An account with this email already exists.');
      throw e;
    }
  }

  async login(body: LoginBody, ip: string): Promise<AuthResult> {
    await this.limiter.hit(`login:ip:${ip}`, LOGIN_PER_IP.limit, LOGIN_PER_IP.windowMs);
    await this.throttle.reserve(body.email);

    const [user] = await this.db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(and(eq(users.email, body.email), isNull(users.deletedAt)));
    // Same work, same error, whether or not the account exists.
    const ok = user ? await this.passwords.verify(user.passwordHash, body.password) : await this.passwords.verifyUnknown(body.password);
    if (!user || !ok) throw new ApiException('INVALID_CREDENTIALS', 'The email or password is wrong.');

    await this.throttle.reset(body.email);
    return this.db.transaction((tx) => this.startSession(tx, user, body.device));
  }

  // Rotates the refresh token: the old one stops working the moment the new one is issued.
  async refresh(refreshToken: string): Promise<{ access_token: string; refresh_token: string }> {
    const hash = this.tokens.hashRefresh(refreshToken);
    const [session] = await this.db
      .select({
        id: authSessions.id,
        userId: authSessions.userId,
        deviceId: authSessions.deviceId,
        revokedAt: authSessions.revokedAt,
        revokedReason: authSessions.revokedReason,
        lastUsedAt: authSessions.lastUsedAt,
        createdAt: authSessions.createdAt,
        userDeletedAt: users.deletedAt,
      })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(eq(authSessions.refreshHash, hash));
    if (!session || session.userDeletedAt) throw unauthenticated();
    if (session.revokedAt) throw session.revokedReason === 'replaced' ? sessionReplaced() : unauthenticated();
    const idleMs = Date.now() - (session.lastUsedAt ?? session.createdAt).getTime();
    if (idleMs > REFRESH_TTL_DAYS * 86_400_000) throw unauthenticated();

    const next = this.tokens.newRefreshToken();
    // The old hash in the WHERE makes a double use lose the race instead of minting two tokens.
    const rotated = await this.db
      .update(authSessions)
      .set({ refreshHash: next.hash, lastUsedAt: sql`now()` })
      .where(and(eq(authSessions.id, session.id), eq(authSessions.refreshHash, hash), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id });
    if (!rotated.length) throw unauthenticated();
    if (session.deviceId) await this.db.update(devices).set({ lastSeenAt: sql`now()` }).where(eq(devices.id, session.deviceId));

    return { access_token: await this.tokens.signAccess({ sub: session.userId, sid: session.id }), refresh_token: next.token };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [session] = await tx
        .update(authSessions)
        .set({ revokedAt: sql`now()`, revokedReason: 'logout' })
        .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
        .returning({ deviceId: authSessions.deviceId });
      if (session?.deviceId) await tx.update(devices).set({ revokedAt: sql`now()` }).where(and(eq(devices.id, session.deviceId), isNull(devices.revokedAt)));
      // The self-profile device on this phone is revoked here once self profiles exist (D-083).
    });
  }

  // One active login per caregiver (D-019), in one transaction. The user row lock makes two sign-ins at the
  // same moment take turns, so the partial unique indexes never see two active rows.
  private async startSession(tx: Tx, user: { id: string; email: string }, device: DeviceInfo): Promise<AuthResult> {
    await tx.execute(sql`select 1 from users where id = ${user.id} for update`);
    const replaced = await tx
      .update(authSessions)
      .set({ revokedAt: sql`now()`, revokedReason: 'replaced' })
      .where(and(eq(authSessions.userId, user.id), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id });
    await tx.update(devices).set({ revokedAt: sql`now()` }).where(and(eq(devices.userId, user.id), isNull(devices.revokedAt)));

    const [row] = await tx
      .insert(devices)
      .values({
        userId: user.id,
        platform: device.platform,
        label: device.label,
        appVersion: device.app_version,
        tz: device.tz,
        pushToken: device.push_token,
        lastSeenAt: sql`now()`,
      })
      .returning({ id: devices.id });
    const refresh = this.tokens.newRefreshToken();
    const [session] = await tx
      .insert(authSessions)
      .values({ userId: user.id, deviceId: row!.id, refreshHash: refresh.hash, lastUsedAt: sql`now()` })
      .returning({ id: authSessions.id });

    return {
      access_token: await this.tokens.signAccess({ sub: user.id, sid: session!.id }),
      refresh_token: refresh.token,
      user: { id: user.id, email: user.email },
      session_replaced_previous: replaced.length > 0,
    };
  }
}

// Drizzle wraps the driver error; the constraint name sits on `cause`.
function violates(e: unknown, constraint: string): boolean {
  const cause = (e as { cause?: { code?: string; constraint?: string } }).cause;
  return cause?.code === '23505' && cause.constraint === constraint;
}
