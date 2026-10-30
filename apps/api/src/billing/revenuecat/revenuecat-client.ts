// What the API needs from RevenueCat: the customer's active entitlements, read with the REST API v2 secret key (R-21..R-24).
export interface ActiveEntitlement {
  entitlementId: string;
  expiresAt: Date | null;
}

export abstract class RevenueCatClient {
  // False when no key is configured (dev): subscription state is then left alone.
  abstract readonly configured: boolean;
  abstract activeEntitlements(appUserId: string): Promise<ActiveEntitlement[]>;
}

const BASE = 'https://api.revenuecat.com/v2';
const MAX_ATTEMPTS = 3;

export class HttpRevenueCatClient extends RevenueCatClient {
  readonly configured = true;

  constructor(
    private readonly secretKey: string,
    private readonly projectId: string,
  ) {
    super();
  }

  async activeEntitlements(appUserId: string): Promise<ActiveEntitlement[]> {
    const out: ActiveEntitlement[] = [];
    let url: string | null = `${BASE}/projects/${encodeURIComponent(this.projectId)}/customers/${encodeURIComponent(appUserId)}/active_entitlements?limit=100`;
    while (url) {
      const res = await this.get(url);
      if (res.status === 404) return []; // a customer RevenueCat has never seen has no entitlements
      if (!res.ok) throw new Error(`RevenueCat ${res.status}`);
      const body = (await res.json()) as { items?: { entitlement_id: string; expires_at: number | null }[]; next_page?: string | null };
      for (const i of body.items ?? []) out.push({ entitlementId: i.entitlement_id, expiresAt: i.expires_at ? new Date(i.expires_at) : null });
      url = body.next_page ? (body.next_page.startsWith('http') ? body.next_page : `https://api.revenuecat.com${body.next_page}`) : null;
    }
    return out;
  }

  // 429 carries Retry-After; 5xx is retried. Customer Information allows 480 requests a minute (R-24).
  private async get(url: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.secretKey}`, Accept: 'application/json' } });
      if ((res.status !== 429 && res.status < 500) || attempt >= MAX_ATTEMPTS) return res;
      await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get('retry-after') ?? 1), 10) * 1000));
    }
  }
}

// Dev and tests. Tests script each customer's entitlements.
export class FakeRevenueCatClient extends RevenueCatClient {
  readonly configured: boolean;
  readonly byUser = new Map<string, ActiveEntitlement[]>();
  calls = 0;

  constructor(configured = true) {
    super();
    this.configured = configured;
  }

  activeEntitlements(appUserId: string): Promise<ActiveEntitlement[]> {
    this.calls++;
    return Promise.resolve(this.byUser.get(appUserId) ?? []);
  }
}
