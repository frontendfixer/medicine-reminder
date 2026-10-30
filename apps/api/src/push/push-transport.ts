// What the API needs from a push provider. Production is the Expo Push Service (D-061).
export interface PushMessage {
  to: string;
  title?: string;
  body?: string;
  data: Record<string, unknown>;
  priority: 'default' | 'normal' | 'high';
  channelId?: string; // Android
  categoryId?: string;
  sound?: 'default' | null;
  interruptionLevel?: 'active' | 'passive' | 'time-sensitive'; // iOS
  contentAvailable?: boolean; // iOS silent push
  collapseId?: string;
  tag?: string; // Android: replaces a displayed notification with the same tag
  ttl?: number; // seconds
}

export type Ticket = { status: 'ok'; id: string } | { status: 'error'; message: string; error?: string };
export type Receipt = { status: 'ok' } | { status: 'error'; message?: string; error?: string };

export abstract class PushTransport {
  // At most 100 messages; tickets come back in the same order. Throws on a request-level failure (429, 5xx).
  abstract send(messages: PushMessage[]): Promise<Ticket[]>;
  // At most 1000 IDs. IDs with no receipt yet are absent from the result.
  abstract receipts(ids: string[]): Promise<Map<string, Receipt>>;
}

export const MAX_MESSAGES_PER_REQUEST = 100;
export const MAX_RECEIPTS_PER_REQUEST = 1000;
