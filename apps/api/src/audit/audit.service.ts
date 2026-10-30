import { Injectable } from '@nestjs/common';
import type { Tx } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export interface AuditEntry {
  actorType: 'caregiver' | 'device' | 'system';
  actorId?: string;
  patientId?: string;
  action: string; // docs/10-security-privacy.md#audit-log
  targetType?: string;
  targetId?: string;
  // IDs and changed field names only. Never medicine names, notes or patient names.
  meta?: Record<string, string | number | boolean | string[]>;
}

// Written in the caller's transaction, so an action and its audit row commit or roll back together.
@Injectable()
export class AuditService {
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLog).values({ ...entry, meta: entry.meta ?? null });
  }
}
