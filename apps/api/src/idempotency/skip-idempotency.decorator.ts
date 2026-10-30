import { SetMetadata } from '@nestjs/common';

export const SKIP_IDEMPOTENCY = 'skipIdempotency';

// For writes that are exempt: auth/* and the RevenueCat webhook (docs/04-api.md#idempotency), and any
// route without a principal or whose response carries a secret (see OI-30).
export const SkipIdempotency = () => SetMetadata(SKIP_IDEMPOTENCY, true);
