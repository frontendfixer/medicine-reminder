import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';
import { ApiException } from '../common/api-exception.js';
import { FieldEncryption } from '../crypto/field-encryption.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { auditLog, doseInstances } from '../db/schema.js';
import { PatientsRepository } from '../patients/patients.repository.js';
import { decodeCursor, encodeCursor } from './cursor.js';

const DAY = 86_400_000;
const DEFAULT_LIMIT = 50;

// docs/04-api.md#history-and-adherence. Read-only, so these work for suspended and archived patients too (07).
@Injectable()
export class HistoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly patients: PatientsRepository,
    private readonly encryption: FieldEncryption,
  ) {}

  async doses(userId: string, patientId: string, q: { from?: string; to?: string; status?: (typeof doseInstances.$inferSelect)['status']; medicine_id?: string; cursor?: string; limit?: number }) {
    const patient = await this.patients.findOwned(userId, patientId);
    const limit = q.limit ?? DEFAULT_LIMIT;
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * DAY);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 14 * DAY);
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;

    const rows = await this.db
      .select()
      .from(doseInstances)
      .where(
        and(
          eq(doseInstances.patientId, patient.id),
          gte(doseInstances.scheduledAt, from),
          lte(doseInstances.scheduledAt, to),
          q.status ? eq(doseInstances.status, q.status) : undefined,
          q.medicine_id ? eq(doseInstances.medicineId, q.medicine_id) : undefined,
          // Newest first: continue strictly after the cursor row.
          cursor ? or(lt(doseInstances.scheduledAt, cursor.t), and(eq(doseInstances.scheduledAt, cursor.t), lt(doseInstances.id, cursor.id))) : undefined,
        ),
      )
      .orderBy(desc(doseInstances.scheduledAt), desc(doseInstances.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((d) => ({
        id: d.id,
        medicine_id: d.medicineId,
        medicine_name: this.encryption.decrypt('dose_instances.name_snapshot', d.nameSnapshot),
        amount: d.amountSnapshot,
        scheduled_at: d.scheduledAt,
        local_time: d.localTime.slice(0, 5),
        status: d.status,
        snooze_until: d.snoozeUntil,
        responded_at: d.respondedAt,
        received_at: d.receivedAt,
        alert_due_at: d.alertDueAt,
      })),
      next_cursor: rows.length > limit && last ? encodeCursor(last.scheduledAt, last.id) : null,
    };
  }

  // Counts per day (in the patient's own timezone) or per medicine. Snoozed doses count as pending.
  async adherence(userId: string, patientId: string, q: { from?: string; to?: string; group_by: 'day' | 'medicine' }) {
    const patient = await this.patients.findOwned(userId, patientId);
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * DAY);
    const to = q.to ? new Date(q.to) : new Date();
    if (from > to) throw ApiException.validation({ from: 'must not be after to' });

    const key = q.group_by === 'day' ? sql`to_char(${doseInstances.scheduledAt} at time zone ${patient.timezone}, 'YYYY-MM-DD')` : sql`${doseInstances.medicineId}::text`;
    const rows = await this.db
      .select({
        key: sql<string>`${key}`,
        taken: sql<number>`count(*) filter (where ${doseInstances.status} = 'taken')::int`,
        not_taken: sql<number>`count(*) filter (where ${doseInstances.status} = 'not_taken')::int`,
        missed: sql<number>`count(*) filter (where ${doseInstances.status} = 'missed')::int`,
        pending: sql<number>`count(*) filter (where ${doseInstances.status} in ('pending','snoozed'))::int`,
      })
      .from(doseInstances)
      .where(and(eq(doseInstances.patientId, patient.id), gte(doseInstances.scheduledAt, from), lte(doseInstances.scheduledAt, to)))
      .groupBy(sql`1`) // by position: the zone is a bound parameter, so repeating the expression would not match
      .orderBy(sql`1`);
    return { buckets: rows };
  }

  async auditLog(userId: string, patientId: string, q: { cursor?: string; limit?: number }) {
    const patient = await this.patients.findOwned(userId, patientId); // the patient's current owner only
    const limit = q.limit ?? DEFAULT_LIMIT;
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.patientId, patient.id), cursor ? or(lt(auditLog.createdAt, cursor.t), and(eq(auditLog.createdAt, cursor.t), lt(auditLog.id, cursor.id))) : undefined))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((a) => ({ id: a.id, actor_type: a.actorType, actor_id: a.actorId, action: a.action, target_type: a.targetType, target_id: a.targetId, meta: a.meta, created_at: a.createdAt })),
      next_cursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}
