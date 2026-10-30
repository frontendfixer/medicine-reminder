import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { type PushMessage, PushTransport, type Receipt, type Ticket } from './push-transport.js';

export class ExpoPushTransport extends PushTransport {
  private readonly expo: Expo;

  // With "enhanced security" on (D-090) every request carries the access token.
  constructor(accessToken: string | undefined) {
    super();
    this.expo = new Expo({ accessToken });
  }

  async send(messages: PushMessage[]): Promise<Ticket[]> {
    const tickets = await this.expo.sendPushNotificationsAsync(messages as ExpoPushMessage[]);
    return tickets.map((t) =>
      t.status === 'ok' ? { status: 'ok', id: t.id } : { status: 'error', message: t.message, error: (t.details as { error?: string } | undefined)?.error },
    );
  }

  async receipts(ids: string[]): Promise<Map<string, Receipt>> {
    const out = new Map<string, Receipt>();
    const found = await this.expo.getPushNotificationReceiptsAsync(ids);
    for (const [id, r] of Object.entries(found)) {
      out.set(id, r.status === 'ok' ? { status: 'ok' } : { status: 'error', message: r.message, error: (r.details as { error?: string } | undefined)?.error });
    }
    return out;
  }
}
