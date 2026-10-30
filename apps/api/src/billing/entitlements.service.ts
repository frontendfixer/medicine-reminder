import { Inject, Injectable } from '@nestjs/common';
import { PLAN_PATIENT_LIMIT, type SubscriptionStatus } from '@med/shared';
import { and, eq, sql } from 'drizzle-orm';
import { ApiException } from '../common/api-exception.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { patients, subscriptions } from '../db/schema.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Statuses that may start something new (docs/07-subscriptions-and-billing.md#quota-enforcement).
// `grace` keeps existing reminders and edits running but is not a reason to take on a new patient.
const CAN_START_NEW: SubscriptionStatus[] = ['active', 'store_grace'];

// Server-side entitlement. The phone never decides what a caregiver may do (D-053).
// Until RevenueCat arrives (Phase 4) the subscription row is created by the dev stub below or by tests.
@Injectable()
export class EntitlementsService {
  private readonly devGrantStarter = process.env.DEV_GRANT_STARTER === 'true';

  constructor(@Inject(DB) private readonly db: Db) {
    if (this.devGrantStarter && process.env.NODE_ENV === 'production') {
      throw new Error('DEV_GRANT_STARTER must not be set in production: it gives every new account a free Starter plan');
    }
  }

  // Dev stub: with DEV_GRANT_STARTER=true, a new account gets the Starter plan so patients can be created
  // before billing exists. Without the flag a new account has no subscription and no access.
  async grantDevStarter(tx: Tx, userId: string): Promise<void> {
    if (!this.devGrantStarter) return;
    await tx
      .insert(subscriptions)
      .values({ userId, plan: 'starter', patientLimit: PLAN_PATIENT_LIMIT.starter, status: 'active', providerRef: userId })
      .onConflictDoNothing();
  }

  // Managed patient: create, accept a transfer, reactivate. Call inside the transaction that writes the patient.
  // The row lock serialises concurrent creates for one caregiver, so the count below can't be raced past the limit.
  async assertManagedQuota(tx: Tx, userId: string): Promise<void> {
    const sub = await this.lock(tx, userId);
    const [{ count }] = (await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(patients)
      .where(and(eq(patients.ownerUserId, userId), eq(patients.type, 'managed'), eq(patients.status, 'active')))) as [{ count: number }];
    if (count >= sub.patientLimit) {
      throw new ApiException('PATIENT_LIMIT_REACHED', `Your plan allows ${sub.patientLimit} patients.`, { limit: sub.patientLimit });
    }
  }

  // Self profile: needs an active subscription, does not count toward the limit (D-008).
  async assertSelfProfileAllowed(tx: Tx, userId: string): Promise<void> {
    await this.lock(tx, userId);
  }

  // Any feature that needs a live subscription but no quota (pairing, transfer codes).
  async assertSubscribed(tx: Tx, userId: string): Promise<void> {
    await this.lock(tx, userId);
  }

  private async lock(tx: Tx, userId: string): Promise<{ status: SubscriptionStatus; patientLimit: number }> {
    const [sub] = await tx
      .select({ status: subscriptions.status, patientLimit: subscriptions.patientLimit })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .for('update');
    if (!sub || !CAN_START_NEW.includes(sub.status)) {
      throw new ApiException('SUBSCRIPTION_INACTIVE', 'An active subscription is needed for this.');
    }
    return sub;
  }

  async summary(userId: string) {
    const [sub] = await this.db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    const [{ count }] = (await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(patients)
      .where(and(eq(patients.ownerUserId, userId), eq(patients.type, 'managed'), eq(patients.status, 'active')))) as [{ count: number }];
    return {
      plan: sub?.plan ?? null,
      patient_limit: sub?.patientLimit ?? 0,
      managed_patients: count,
      status: sub?.status ?? null,
      renews_at: sub?.renewsAt ?? null,
      expired_at: sub?.expiredAt ?? null,
      cutoff_at: sub?.cutoffAt ?? null,
    };
  }
}
