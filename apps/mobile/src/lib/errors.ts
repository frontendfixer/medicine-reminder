import type { ErrorCode } from '@med/shared';
import { ApiError } from '../api/http';
import type { MessageKey } from '../i18n';

// The message to show for a failed call. A screen passes the codes it can explain in its own words; everything else falls
// back to a plain network / rate-limit / generic message.
export function messageFor(e: unknown, specific: Partial<Record<ErrorCode, MessageKey>> = {}): MessageKey {
  if (!(e instanceof ApiError)) return 'error.generic';
  if (e.code === 'NETWORK') return 'error.network';
  if (e.code in specific) return specific[e.code as ErrorCode]!;
  if (e.code === 'RATE_LIMITED') return 'error.rateLimited';
  if (e.code === 'UPGRADE_REQUIRED') return 'error.upgradeRequired';
  return 'error.generic';
}
