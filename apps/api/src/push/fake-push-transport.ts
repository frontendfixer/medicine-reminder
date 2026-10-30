import { type PushMessage, PushTransport, type Receipt, type Ticket } from './push-transport.js';

// For local development and tests: nothing leaves the machine. Tests script the outcomes.
export class FakePushTransport extends PushTransport {
  readonly sent: PushMessage[] = [];
  ticketFor: (m: PushMessage, index: number) => Ticket = (_m, i) => ({ status: 'ok', id: `ticket-${this.sent.length}-${i}` });
  receiptFor: (id: string) => Receipt | undefined = () => ({ status: 'ok' });
  failNext = 0; // makes the next N send() calls throw, like a 5xx

  send(messages: PushMessage[]): Promise<Ticket[]> {
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error('push service unavailable'));
    }
    const tickets = messages.map((m, i) => this.ticketFor(m, i));
    this.sent.push(...messages);
    return Promise.resolve(tickets);
  }

  receipts(ids: string[]): Promise<Map<string, Receipt>> {
    const out = new Map<string, Receipt>();
    for (const id of ids) {
      const r = this.receiptFor(id);
      if (r) out.set(id, r);
    }
    return Promise.resolve(out);
  }
}
