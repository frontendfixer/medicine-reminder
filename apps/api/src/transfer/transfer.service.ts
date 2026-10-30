import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { ApiException } from '../common/api-exception.js';
import { FieldEncryption } from '../crypto/field-encryption.js';
import type { Db, Tx } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { pairingCodes, patients } from '../db/schema.js';
import { HealthService } from '../jobs/health.service.js';
import { expired, isLive, PairingService } from '../pairing/pairing.service.js';
import { PatientsRepository, assertPatientWritable } from '../patients/patients.repository.js';
import { patientView } from '../patients/patient-view.js';
import { RateLimiter } from '../redis/rate-limiter.js';

const REDEEM_LIMIT = { limit: 10, windowMs: 60_000 };

// docs/06-pairing-and-devices.md#transfer, D-049, D-050.
@Injectable()
export class TransferService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly pairing: PairingService,
    private readonly entitlements: EntitlementsService,
    private readonly patients: PatientsRepository,
    private readonly encryption: FieldEncryption,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    private readonly health: HealthService,
  ) {}

  async createCode(userId: string, patientId: string) {
    return this.db.transaction(async (tx) => {
      await this.entitlements.assertSubscribed(tx, userId);
      const patient = await this.patients.lockOwned(tx, userId, patientId);
      assertPatientWritable(patient); // an active patient only: a suspended one is waiting for a renewal
      const result = await this.pairing.createCode(tx, userId, patientId, 'transfer');
      await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, patientId, action: 'transfer.code_created', targetType: 'patient', targetId: patientId });
      return result;
    });
  }

  async redeem(receiverId: string, rawCode: string, asSelf: boolean) {
    await this.limiter.hit(`transfer:user:${receiverId}`, REDEEM_LIMIT.limit, REDEEM_LIMIT.windowMs);
    const match = await this.pairing.locate('transfer', rawCode);
    const [before] = await this.db.select().from(patients).where(eq(patients.id, match.patientId));
    if (!before || before.ownerUserId === receiverId) throw new ApiException('CODE_INVALID', 'That code is not right.'); // your own patient

    const moved = await this.db.transaction(async (tx) => {
      // Receiver's subscription first, then the patient, then the code: the order everywhere.
      if (asSelf) {
        await this.entitlements.assertSelfProfileAllowed(tx, receiverId);
        await this.assertNoSelfProfile(tx, receiverId);
      } else {
        await this.entitlements.assertManagedQuota(tx, receiverId);
      }
      const [patient] = await tx.select().from(patients).where(eq(patients.id, match.patientId)).for('update');
      const [code] = await tx.select().from(pairingCodes).where(eq(pairingCodes.id, match.id)).for('update');
      if (!patient || !code || !isLive(code) || code.expiresAt <= new Date()) throw expired();
      assertPatientWritable(patient);
      const oldOwner = patient.ownerUserId;
      if (oldOwner === receiverId) throw new ApiException('CODE_INVALID', 'That code is not right.');

      await tx.update(pairingCodes).set({ usedAt: sql`now()` }).where(eq(pairingCodes.id, code.id));
      // Medicines, schedule versions, dose history, devices and tokens stay exactly where they are: only the owner changes.
      const [row] = await tx
        .update(patients)
        .set({ ownerUserId: receiverId, type: asSelf ? 'self' : 'managed', updatedAt: sql`now()` })
        .where(eq(patients.id, patient.id))
        .returning();
      // A pairing code the old owner made earlier must not add phones to a patient they no longer own.
      await tx
        .update(pairingCodes)
        .set({ invalidatedAt: sql`now()` })
        .where(and(eq(pairingCodes.patientId, patient.id), isNull(pairingCodes.usedAt), isNull(pairingCodes.invalidatedAt)));
      await this.audit.record(tx, { actorType: 'caregiver', actorId: receiverId, patientId: patient.id, action: 'transfer.redeemed', targetType: 'patient', targetId: patient.id, meta: { role: 'receiver', as_self: asSelf } });
      await this.audit.record(tx, { actorType: 'caregiver', actorId: oldOwner, patientId: patient.id, action: 'transfer.redeemed', targetType: 'patient', targetId: patient.id, meta: { role: 'sender', to: receiverId } });
      return row!;
    });

    const active = (await this.patients.activeDevices([moved.id])).get(moved.id) ?? [];
    return patientView(moved, active, this.encryption, await this.health.problemsFor(active));
  }

  private async assertNoSelfProfile(tx: Tx, userId: string): Promise<void> {
    const [existing] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.ownerUserId, userId), eq(patients.type, 'self'), sql`${patients.status} <> 'archived'`));
    if (existing) throw new ApiException('SELF_PROFILE_EXISTS', 'You already have a self profile.');
  }
}
