import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { caregiverSettings } from '../db/schema.js';
import { DosesService } from '../doses/doses.service.js';
import type { UpdateSettingsBody } from './settings.dto.js';

const view = (r: typeof caregiverSettings.$inferSelect) => ({ default_missed_delay_min: r.defaultMissedDelayMin, lockscreen_detail: r.lockscreenDetail, daily_summary: r.dailySummary });

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly doses: DosesService,
    private readonly audit: AuditService,
  ) {}

  async get(userId: string) {
    const [row] = await this.db.select().from(caregiverSettings).where(eq(caregiverSettings.userId, userId));
    return view(row!);
  }

  async update(userId: string, body: UpdateSettingsBody) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(caregiverSettings)
        .set({
          ...(body.default_missed_delay_min !== undefined ? { defaultMissedDelayMin: body.default_missed_delay_min } : {}),
          ...(body.lockscreen_detail !== undefined ? { lockscreenDetail: body.lockscreen_detail } : {}),
          ...(body.daily_summary !== undefined ? { dailySummary: body.daily_summary } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(caregiverSettings.userId, userId))
        .returning();
      // D-086: a new default delay reaches doses that are still in the future.
      if (body.default_missed_delay_min !== undefined) await this.doses.recomputeAlertDue(tx, { ownerUserId: userId });
      await this.audit.record(tx, { actorType: 'caregiver', actorId: userId, action: 'settings.updated', meta: { fields: Object.keys(body).sort((a, b) => (a < b ? -1 : 1)) } });
      return view(row!);
    });
  }
}
