import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { DB } from '../db/database.module.js';
import { devices, notificationLog } from '../db/schema.js';
import { NotificationComposer } from './composer.js';
import { MAX_MESSAGES_PER_REQUEST, MAX_RECEIPTS_PER_REQUEST, PushTransport, type Ticket } from './push-transport.js';

const BACKOFF_MS = [200, 800]; // then give up for this run; the row stays queued for the next one
const RECEIPT_MIN_AGE_MS = 15 * 60_000; // receipts are ready after about 15 minutes (R-08)
const RECEIPT_MAX_AGE_MS = 24 * 3_600_000; // and are deleted after 24 hours
const CONFIG_ERRORS = new Set(['InvalidCredentials', 'MismatchSenderId']);

// notification_log is the outbox (05): rows are committed as `queued` inside the transaction that decided to notify,
// and this sends them. A crash between commit and send leaves them queued for the next run.
@Injectable()
export class OutboxSender {
  private readonly log = new Logger(OutboxSender.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly composer: NotificationComposer,
    private readonly transport: PushTransport,
  ) {}

  // Sends queued rows in batches of up to 100 until none are left or the time budget is spent.
  async sendQueued(budgetMs = 50_000): Promise<number> {
    const deadline = Date.now() + budgetMs;
    let sent = 0;
    while (Date.now() < deadline) {
      const n = await this.sendBatch();
      if (n === 0) break;
      sent += n;
    }
    return sent;
  }

  // Returns how many rows left the queue (sent or failed for good). Zero means nothing to do, or the provider is down.
  private async sendBatch(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(notificationLog)
        .where(eq(notificationLog.status, 'queued'))
        .orderBy(asc(notificationLog.createdAt))
        .limit(MAX_MESSAGES_PER_REQUEST)
        .for('update', { skipLocked: true });
      if (!rows.length) return 0;

      const messages = await this.composer.compose(rows);
      const unsendable = rows.filter((r) => !messages.has(r.id));
      for (const row of unsendable) await tx.update(notificationLog).set({ status: 'failed', ticketStatus: 'error', ticketError: 'not_sendable' }).where(eq(notificationLog.id, row.id)); // device gone, no valid token, or nothing to say

      const sendable = rows.filter((r) => messages.has(r.id));
      if (!sendable.length) return rows.length;
      const tickets = await this.sendWithBackoff(sendable.map((r) => messages.get(r.id)!));
      if (!tickets) return unsendable.length; // provider unavailable: leave the rest queued

      const now = new Date();
      for (const [i, row] of sendable.entries()) {
        const ticket = tickets[i]!;
        if (ticket.status === 'ok') {
          await tx.update(notificationLog).set({ status: 'sent', ticketStatus: 'ok', expoTicketId: ticket.id, sentAt: now }).where(eq(notificationLog.id, row.id));
        } else if (ticket.error === 'MessageRateExceeded') {
          continue; // back off: stays queued, tried again next run
        } else {
          await tx.update(notificationLog).set({ status: 'failed', ticketStatus: 'error', ticketError: ticket.error ?? 'unknown', sentAt: now }).where(eq(notificationLog.id, row.id));
          if (ticket.error === 'DeviceNotRegistered' && row.deviceId) await this.invalidateToken(tx, row.deviceId);
          if (ticket.error && CONFIG_ERRORS.has(ticket.error)) this.log.error(`Push configuration error: ${ticket.error}`); // pages the owner via the log alert (14)
        }
      }
      return rows.length;
    });
  }

  private async sendWithBackoff(messages: Parameters<PushTransport['send']>[0]): Promise<Ticket[] | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transport.send(messages);
      } catch {
        if (attempt >= BACKOFF_MS.length) {
          this.log.warn('Push provider unavailable; rows stay queued');
          return null;
        }
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }
    }
  }

  // Receipts for tickets between 15 minutes and 24 hours old (05). A DeviceNotRegistered receipt drops the token.
  async processReceipts(now = new Date()): Promise<number> {
    let processed = 0;
    for (;;) {
      const n = await this.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(notificationLog)
          .where(and(sql`${notificationLog.expoTicketId} is not null`, sql`${notificationLog.receiptCheckedAt} is null`, lt(notificationLog.sentAt, new Date(now.getTime() - RECEIPT_MIN_AGE_MS))))
          .orderBy(asc(notificationLog.sentAt))
          .limit(MAX_RECEIPTS_PER_REQUEST)
          .for('update', { skipLocked: true });
        if (!rows.length) return 0;

        const receipts = await this.transport.receipts(rows.map((r) => r.expoTicketId!));
        for (const row of rows) {
          const receipt = receipts.get(row.expoTicketId!);
          if (!receipt) {
            // Receipts disappear after 24 hours: stop asking.
            if (row.sentAt && row.sentAt.getTime() < now.getTime() - RECEIPT_MAX_AGE_MS) {
              await tx.update(notificationLog).set({ receiptStatus: 'expired', receiptCheckedAt: now }).where(eq(notificationLog.id, row.id));
            }
            continue;
          }
          await tx
            .update(notificationLog)
            .set({ receiptStatus: receipt.status, receiptError: receipt.status === 'error' ? (receipt.error ?? 'unknown') : null, receiptCheckedAt: now })
            .where(eq(notificationLog.id, row.id));
          if (receipt.status === 'error' && receipt.error === 'DeviceNotRegistered' && row.deviceId) await this.invalidateToken(tx, row.deviceId);
          if (receipt.status === 'error' && receipt.error && CONFIG_ERRORS.has(receipt.error)) this.log.error(`Push configuration error: ${receipt.error}`);
        }
        return rows.length;
      });
      processed += n;
      if (n < MAX_RECEIPTS_PER_REQUEST) break;
    }
    return processed;
  }

  // The device counts as unhealthy until it re-registers a token with its next heartbeat (09).
  private async invalidateToken(tx: Parameters<Parameters<Db['transaction']>[0]>[0], deviceId: string): Promise<void> {
    await tx.update(devices).set({ pushToken: null, pushInvalidAt: sql`now()` }).where(eq(devices.id, deviceId));
  }
}

