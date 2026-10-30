// Imported first by main.ts and worker.ts. Does nothing unless SENTRY_DSN is set.
import { initSentry } from './sentry.js';

if (process.env.SENTRY_DSN) initSentry();
