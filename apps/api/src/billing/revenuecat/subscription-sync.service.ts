import { Inject, Injectable, Logger } from '@nestjs/common';
import { PLAN_PATIENT_LIMIT, type PlanId } from '@med/shared';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service.js';
import type { Db, Tx } from '../../db/client.js';
import { DB } from '../../db/database.module.js';
import { devices, notificationLog, patients, rcWebhookEvents, subscriptions, users } from '../../db/schema.js';
import { DosesService } from '../../doses/doses.service.js';
import { RevenueCatClient } from './revenuecat-client.js';

export const GRACE_MS = 24 * 3_600_000; // D-054
const RECONCILE_DAYS = 90; // docs/07: users expired within the last 90 days are still checked
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HANDLED = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'CANCELLATION', 'UNCANCELLATION', 'BILLING_ISSUE', 'EXPIRATION', 'PRODUCT_CHANGE', 'SUBSCRIPTION_PAUSED', 'SUBSCRIPTION_EXTENDED', 'TRANSFER', 'TEMPORARY_ENTITLEMENT_GRANT']);

export interface RcEvent {
  id: string;
  type: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  environment?: string;
}

// Entitlement id → plan. Plan names and prices are still OI-01; only Starter exists.
export function planMap(): Record<string, PlanId> {
  try {
    return JSON.parse(process.env.REVENUECAT_PLAN_MAP ?? '{"starter":"starter"}') as Record<string, PlanId>;
  } catch {
    return {};
  }
}

// docs/07-subscriptions-and-billing.md. State always comes from RevenueCat's current answer, never from the event
// body: webhooks only say "look again", so duplicates and out-of-order delivery converge (R-21, D-051).
@Injectable()
export class SubscriptionSyncService {
  private readonly log = new Logger(SubscriptionSyncService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly rc: RevenueCatClient,
    private readonly doses: DosesService,
    private readonly audit: AuditService,
  ) {}

  // Webhook rows waiting to be processed (the API only records them, so it can answer within RevenueCat's 60 s).
  async processPending(limit = 50): Promise<number> {
    const rows = await this.db.select().from(rcWebhookEvents).where(isNull(rcWebhookEvents.processedAt)).orderBy(rcWebhookEvents.receivedAt).limit(limit);
    for (const row of rows) {
      try {
        await this.processEvent(row.eventId, row.type, row.appUserId, row.payload as RcEvent | null);
      } catch (e) {
        this.log.error(`RevenueCat event failed: ${e instanceof Error ? e.name : 'error'}`); // stays unprocessed: retried next run
        continue;
      }
      await this.db.update(rcWebhookEvents).set({ processedAt: sql`now()` }).where(eq(rcWebhookEvents.eventId, row.eventId));
    }
    return rows.length;
  }

  private async processEvent(eventId: string, type: string, _appUserId: string | null, event: RcEvent | null): Promise<void> {
    if (!event || !HANDLED.has(type)) return; // TEST and anything new: log and ignore
    if (event.environment === 'SANDBOX' && process.env.NODE_ENV === 'production') return; // sandbox purchases never unlock production
    const ids = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])].filter((x): x is string => !!x && UUID.test(x));
    const found = ids.length ? await this.db.select({ id: users.id }).from(users).where(inArray(users.id, ids)) : [];
    for (const u of found) await this.sync(u.id, { eventId, billingIssue: type === 'BILLING_ISSUE' });
  }

  // Re-reads the customer and applies the state machine. Returns whether anything changed.
  async sync(userId: string, opts: { eventId?: string; billingIssue?: boolean } = {}): Promise<boolean> {
    if (!this.rc.configured) return false; // dev: leave the stubbed subscription alone
    const entitlements = await this.rc.activeEntitlements(userId);
    const plans = planMap();
    const best = entitlements
      .map((e) => ({ plan: plans[e.entitlementId], expiresAt: e.expiresAt }))
      .filter((e): e is { plan: PlanId; expiresAt: Date | null } => !!e.plan)
      .sort((a, b) => PLAN_PATIENT_LIMIT[b.plan] - PLAN_PATIENT_LIMIT[a.plan])[0];

    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, userId)).for('update');

      if (best) {
        const status = opts.billingIssue ? 'store_grace' : 'active';
        const restoring = current?.status === 'grace' || current?.status === 'expired';
        const values = { plan: best.plan, patientLimit: PLAN_PATIENT_LIMIT[best.plan], status, renewsAt: best.expiresAt, expiredAt: null, cutoffAt: null, providerRef: userId, lastEventId: opts.eventId ?? current?.lastEventId ?? null, updatedAt: new Date() } as const;
        await tx.insert(subscriptions).values({ userId, ...values }).onConflictDoUpdate({ target: subscriptions.userId, set: values });
        if (restoring) await this.restore(tx, userId);
        return !current || current.status !== status || current.plan !== best.plan || current.patientLimit !== PLAN_PATIENT_LIMIT[best.plan] || restoring;
      }

      // No access any more. Start the 1-day grace once; leave grace and expired alone.
      if (current && (current.status === 'active' || current.status === 'store_grace')) {
        const now = new Date();
        await tx.update(subscriptions).set({ status: 'grace', expiredAt: now, cutoffAt: new Date(now.getTime() + GRACE_MS), lastEventId: opts.eventId ?? current.lastEventId, updatedAt: now }).where(eq(subscriptions.userId, userId));
        const carers = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
        if (carers.length) await tx.insert(notificationLog).values(carers.map((c) => ({ kind: 'billing' as const, deviceId: c.id, data: { event: 'expired' } })));
        await this.audit.record(tx, { actorType: 'system', actorId: userId, action: 'billing.grace_started', targetType: 'user', targetId: userId });
        return true;
      }
      return false;
    });
  }

  // Renewal after grace or cutoff: patients come back, doses are rebuilt, phones re-sync (07#renewal).
  private async restore(tx: Tx, userId: string): Promise<void> {
    const back = await tx
      .update(patients)
      .set({ status: 'active', suspendedAt: null, updatedAt: sql`now()` })
      .where(and(eq(patients.ownerUserId, userId), eq(patients.status, 'suspended'), isNotNull(patients.suspendedAt)))
      .returning({ id: patients.id });
    for (const p of back) {
      await this.doses.regeneratePatient(tx, p.id); // doses scheduled during the suspension never existed, so nothing is back-filled
      const phones = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.patientId, p.id), isNull(devices.revokedAt)));
      if (phones.length) await tx.insert(notificationLog).values(phones.map((d) => ({ kind: 'sync' as const, patientId: p.id, deviceId: d.id, data: { command: 'sync' } })));
    }
    await this.audit.record(tx, { actorType: 'system', actorId: userId, action: 'billing.restored', targetType: 'user', targetId: userId, meta: { patients: back.length } });
  }

  // Daily (07#reconciliation): catches webhooks we never received. Returns how many accounts it had to fix.
  async reconcile(pauseMs = 150): Promise<{ checked: number; fixed: number }> {
    if (!this.rc.configured) return { checked: 0, fixed: 0 };
    const since = new Date(Date.now() - RECONCILE_DAYS * 86_400_000);
    const rows = await this.db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(sql`${subscriptions.status} in ('active','store_grace','grace') or (${subscriptions.status} = 'expired' and ${subscriptions.expiredAt} > ${since})`);
    let fixed = 0;
    for (const { userId } of rows) {
      if (await this.sync(userId)) {
        fixed++;
        this.log.warn('Reconciliation fixed a subscription the webhooks missed'); // a high rate means webhooks are being lost (07)
      }
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs)); // stay under 480 requests a minute (R-24)
    }
    return { checked: rows.length, fixed };
  }
}
