import { createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { ApiException } from '../common/api-exception.js';
import { FieldEncryption } from '../crypto/field-encryption.js';
import { Hmac } from '../crypto/hmac.js';
import type { Db, Tx } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { consents, devices, notificationLog, pairingCodes, patients } from '../db/schema.js';
import { PatientsRepository } from '../patients/patients.repository.js';
import { RateLimiter } from '../redis/rate-limiter.js';
import { formatCode, generateCode, lookupPart, normalizeCode, qrPayload } from './pairing-code.js';
import type { RedeemBody } from './pairing.dto.js';

export const CODE_TTL_MINUTES = 10; // D-011
export const MAX_FAILED_ATTEMPTS = 5; // D-012
export const MAX_ACTIVE_DEVICES = 3; // D-018, D-084
const CHALLENGE_TTL_SECONDS = 300;
// D-084: 10 per minute per IP, 5 per 10 minutes per install. The global ceiling is a suggestion.
const LIMITS = { ip: [10, 60_000], install: [5, 600_000], global: [300, 60_000] } as const;

type CodeKind = 'pair' | 'transfer';
type CodeRow = typeof pairingCodes.$inferSelect;

@Injectable()
export class PairingService {
  private readonly pepper: Buffer;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly hmac: Hmac,
    private readonly entitlements: EntitlementsService,
    private readonly patients: PatientsRepository,
    private readonly encryption: FieldEncryption,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
  ) {
    this.pepper = Buffer.from(process.env.HMAC_PEPPER ?? '', 'base64');
  }

  // Shared by pairing and transfer codes (06): same format, lifetime and storage, different `kind`.
  async createCode(tx: Tx, userId: string, patientId: string, kind: CodeKind) {
    const code = generateCode();
    await tx
      .update(pairingCodes)
      .set({ invalidatedAt: sql`now()` })
      .where(and(eq(pairingCodes.patientId, patientId), eq(pairingCodes.kind, kind), isNull(pairingCodes.usedAt), isNull(pairingCodes.invalidatedAt)));
    const [row] = await tx
      .insert(pairingCodes)
      .values({
        patientId,
        kind,
        createdByUserId: userId,
        lookupHash: this.hmac.hex('code-lookup', kind, lookupPart(code)),
        codeHash: this.hmac.hex('code-full', kind, code),
        expiresAt: sql`now() + make_interval(mins => ${CODE_TTL_MINUTES})`,
      })
      .returning({ expiresAt: pairingCodes.expiresAt });
    return { code: formatCode(code), qr_payload: qrPayload(code, kind), expires_at: row!.expiresAt };
  }

  async createPairingCode(userId: string, patientId: string) {
    return this.db.transaction(async (tx) => {
      await this.entitlements.assertSubscribed(tx, userId);
      const patient = await this.patients.lockOwned(tx, userId, patientId);
      if (patient.status === 'archived') throw new ApiException('PATIENT_ARCHIVED', 'This patient is archived. Reactivate them first.');
      if (patient.status === 'suspended') throw new ApiException('PATIENT_SUSPENDED', 'Reminders are paused until the subscription is renewed.');
      const result = await this.createCode(tx, userId, patientId, 'pair');
      await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId, action: 'pairing.code_created', targetType: 'patient', targetId: patientId });
      return result;
    });
  }

  // Stateless challenge for Play Integrity / App Attest: a signed nonce with an expiry.
  challenge(platform: string) {
    const expires = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;
    const body = `${randomBytes(16).toString('base64url')}.${expires}.${platform}`;
    const sig = createHmac('sha256', this.pepper).update(`challenge:${body}`).digest('base64url');
    return { challenge: `${body}.${sig}`, expires_at: new Date(expires * 1000) };
  }

  async redeem(body: RedeemBody, ip: string) {
    await this.rateLimit(ip, body.device.install_id);

    const code = normalizeCode(body.code);
    if (!code) throw invalid();
    const lookup = this.hmac.hex('code-lookup', 'pair', lookupPart(code));
    const full = this.hmac.hex('code-full', 'pair', code);

    // 1. Find the code without locking: redeem takes locks in the same order as everything else
    //    (subscription, patient, code), so it can't deadlock with code generation.
    const candidates = await this.db
      .select()
      .from(pairingCodes)
      .where(and(eq(pairingCodes.lookupHash, lookup), eq(pairingCodes.kind, 'pair'), gt(pairingCodes.createdAt, sql`now() - interval '1 day'`)));
    const match = candidates.find((c) => c.codeHash === full);
    if (!match) {
      // A wrong code against a live lookup ID counts as a failed attempt on that code (D-084).
      const live = candidates.filter((c) => isLive(c));
      if (live.length) {
        await this.db
          .update(pairingCodes)
          .set({ failedAttempts: sql`${pairingCodes.failedAttempts} + 1` })
          .where(inArray(pairingCodes.id, live.map((c) => c.id)));
      }
      throw invalid();
    }

    const [owner] = await this.db.select({ ownerUserId: patients.ownerUserId }).from(patients).where(eq(patients.id, match.patientId));
    if (!owner) throw invalid();

    const result = await this.db.transaction(async (tx) => {
      await this.entitlements.assertSubscribed(tx, owner.ownerUserId);
      const [patient] = await tx.select().from(patients).where(eq(patients.id, match.patientId)).for('update');
      const [row] = await tx.select().from(pairingCodes).where(eq(pairingCodes.id, match.id)).for('update');
      if (!patient || !row || !isLive(row) || row.expiresAt <= new Date()) throw expired();
      if (patient.status === 'suspended') throw new ApiException('PATIENT_SUSPENDED', 'Reminders are paused until the subscription is renewed.');
      if (patient.status !== 'active') throw expired();

      // Re-pairing the same install replaces its old device row instead of using a second slot.
      const replaced = await tx
        .update(devices)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(devices.patientId, patient.id), eq(devices.installId, body.device.install_id), isNull(devices.revokedAt)))
        .returning({ id: devices.id });
      const [{ count }] = (await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(devices)
        .where(and(eq(devices.patientId, patient.id), isNull(devices.revokedAt)))) as [{ count: number }];
      if (count >= MAX_ACTIVE_DEVICES) throw new ApiException('DEVICE_LIMIT_REACHED', `A patient can use up to ${MAX_ACTIVE_DEVICES} phones. Remove one first.`, { limit: MAX_ACTIVE_DEVICES });

      await tx.update(pairingCodes).set({ usedAt: sql`now()` }).where(eq(pairingCodes.id, row.id));
      const token = randomBytes(32).toString('base64url');
      const [device] = await tx
        .insert(devices)
        .values({
          patientId: patient.id,
          tokenHash: this.hashDeviceToken(token),
          platform: body.device.platform,
          label: body.device.label,
          installId: body.device.install_id,
          appVersion: body.device.app_version,
          tz: body.device.tz,
          pushToken: body.device.push_token,
          lastSeenAt: sql`now()`,
        })
        .returning({ id: devices.id });
      await tx.insert(consents).values({ subjectType: 'patient', patientId: patient.id, deviceId: device!.id, kind: 'pairing', noticeVersion: body.consent.notice_version });

      for (const old of replaced) {
        await this.audit.record(tx, { actorType: 'system', patientId: patient.id, action: 'device.revoked', targetType: 'device', targetId: old.id, meta: { reason: 'repaired' } });
      }
      await this.audit.record(tx, {
        actorType: 'device',
        actorId: device!.id,
        patientId: patient.id,
        action: 'pairing.redeemed',
        targetType: 'device',
        targetId: device!.id,
        // Log-only (D-013): whether a token was sent, not whether it was valid.
        meta: { attestation: body.attestation ? 'provided_unverified' : 'none' },
      });
      // "Patient connected on …" for the caregiver's phone; the push sender picks queued rows up.
      const caregiverDevices = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, owner.ownerUserId), isNull(devices.revokedAt)));
      if (caregiverDevices.length) {
        await tx.insert(notificationLog).values(caregiverDevices.map((d) => ({ kind: 'pairing' as const, patientId: patient.id, deviceId: d.id, data: { event: 'connected', device_label: body.device.label ?? null } })));
      }
      return { device_id: device!.id, device_token: token, patient: { id: patient.id, display_name: this.encryption.decrypt('patients.display_name', patient.displayName), timezone: patient.timezone } };
    });
    return result;
  }

  hashDeviceToken(token: string): string {
    return this.hmac.hex('device-token', token);
  }

  // Redeem fails closed: if Redis can't count, the attempt is refused (pairing is rare; reminders don't depend on it).
  private async rateLimit(ip: string, installId: string): Promise<void> {
    try {
      await this.limiter.hit(`pair:ip:${ip}`, ...LIMITS.ip);
      await this.limiter.hit(`pair:install:${installId}`, ...LIMITS.install);
      await this.limiter.hit('pair:global', ...LIMITS.global);
    } catch (e) {
      if (e instanceof ApiException) throw e;
      throw new ApiException('RATE_LIMITED', 'Pairing is temporarily unavailable. Try again shortly.', {}, 30);
    }
  }
}

const isLive = (c: CodeRow) => !c.usedAt && !c.invalidatedAt && c.expiresAt > new Date() && c.failedAttempts < MAX_FAILED_ATTEMPTS;
const invalid = () => new ApiException('CODE_INVALID', 'That code is not right.');
const expired = () => new ApiException('CODE_EXPIRED_OR_USED', 'That code has expired or was already used. Ask for a new one.');
