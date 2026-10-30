import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { FieldEncryption } from '../crypto/field-encryption.js';
import { DB } from '../db/database.module.js';
import type { Db } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';

export const RETENTION_HOURS = 24; // D-083
export const STALE_CLAIM_SECONDS = 60; // a claim with no result after this is treated as abandoned

export type Claim =
  | { kind: 'claimed' }
  | { kind: 'conflict' } // same key, different request
  | { kind: 'in_progress' }
  | { kind: 'replay'; status: number; body: unknown };

@Injectable()
export class IdempotencyStore {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly encryption: FieldEncryption,
  ) {}

  // Atomically takes (principal, key) so only one request runs the handler.
  async claim(principal: string, key: string, methodPath: string, requestHash: string): Promise<Claim> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await this.db
        .insert(idempotencyKeys)
        .values({ principal, key, methodPath, requestHash })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      if (inserted.length) return { kind: 'claimed' };

      // Expired (24 h) or abandoned claims are taken over. UPDATE row-locks, so only one taker wins.
      const reclaimed = await this.db
        .update(idempotencyKeys)
        .set({ methodPath, requestHash, statusCode: null, responseBody: null, createdAt: sql`now()` })
        .where(
          and(
            eq(idempotencyKeys.principal, principal),
            eq(idempotencyKeys.key, key),
            sql`(${idempotencyKeys.createdAt} < now() - make_interval(hours => ${RETENTION_HOURS})
              or (${idempotencyKeys.statusCode} is null and ${idempotencyKeys.createdAt} < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})))`,
          ),
        )
        .returning({ key: idempotencyKeys.key });
      if (reclaimed.length) return { kind: 'claimed' };

      const [row] = await this.db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.principal, principal), eq(idempotencyKeys.key, key)));
      if (!row) continue; // released between our statements: try again
      if (row.methodPath !== methodPath || row.requestHash !== requestHash) return { kind: 'conflict' };
      if (row.statusCode === null) return { kind: 'in_progress' };
      return { kind: 'replay', status: row.statusCode, body: this.open(row.responseBody) };
    }
    return { kind: 'in_progress' };
  }

  async complete(principal: string, key: string, status: number, body: unknown): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({ statusCode: status, responseBody: this.seal(body) })
      .where(and(eq(idempotencyKeys.principal, principal), eq(idempotencyKeys.key, key)));
  }

  // Lets the client retry with the same key after a failure that must not be replayed.
  async release(principal: string, key: string): Promise<void> {
    await this.db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.principal, principal), eq(idempotencyKeys.key, key), sql`${idempotencyKeys.statusCode} is null`));
  }

  // Responses can contain medicine names, so they are stored encrypted (D-066), as a JSON string.
  private seal(body: unknown): string {
    return this.encryption.encrypt('idempotency_keys.response_body', JSON.stringify(body ?? null)).toString('utf8');
  }

  private open(stored: unknown): unknown {
    if (typeof stored !== 'string') return undefined;
    return JSON.parse(this.encryption.decrypt('idempotency_keys.response_body', Buffer.from(stored, 'utf8'))) ?? undefined;
  }
}
