import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { patients, subscriptions } from '../db/schema.js';
import { DosesService } from '../doses/doses.service.js';

// The daily top-up (D-034). Edits, timezone changes and reactivation generate synchronously in their own transaction;
// this keeps the 14-day horizon full as days pass. Safe to repeat: existing doses are kept.
@Injectable()
export class DoseGeneratorService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly doses: DosesService,
  ) {}

  async generateAll(now = new Date()): Promise<number> {
    // Active patients whose owner may still use the service; suspended and archived ones are skipped (07).
    const rows = await this.db
      .select({ id: patients.id })
      .from(patients)
      .innerJoin(subscriptions, eq(subscriptions.userId, patients.ownerUserId))
      .where(and(eq(patients.status, 'active'), inArray(subscriptions.status, ['active', 'store_grace', 'grace'])));
    let created = 0;
    for (const { id } of rows) created += await this.db.transaction((tx) => this.doses.generateForPatient(tx, id, now));
    return created;
  }
}
