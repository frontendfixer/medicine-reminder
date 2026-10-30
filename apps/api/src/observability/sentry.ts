import * as Sentry from '@sentry/nestjs';
import { scrubBreadcrumb, scrubEvent } from './scrub.js';

// Errors only: no tracing, no profiling, no request bodies, no user details, no local variables (D-063).
// `dataCollection` is the current switchboard (SDK 10.57+); `sendDefaultPii` no longer exists in 11.x.
// Whatever the SDK still collects goes through scrubEvent / scrubBreadcrumb before it leaves the process.
export function initSentry(overrides: Partial<Sentry.NodeOptions> = {}): void {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    includeLocalVariables: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 20,
    dataCollection: { userInfo: false, cookies: false, urlQueryParams: false, databaseQueryData: false, stackFrameVariables: false },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    ...overrides,
  });
}
