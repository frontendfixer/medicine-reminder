import { ApiError } from '../api/http';
import { messageFor } from './errors';

describe('messageFor', () => {
  it('prefers what the screen can explain', () => {
    expect(messageFor(new ApiError('CODE_INVALID', 422, 'x'), { CODE_INVALID: 'pair.error.invalid' })).toBe('pair.error.invalid');
  });
  it('falls back to network, rate limit, upgrade and generic', () => {
    expect(messageFor(new ApiError('NETWORK', 0, 'x'))).toBe('error.network');
    expect(messageFor(new ApiError('RATE_LIMITED', 429, 'x'))).toBe('error.rateLimited');
    expect(messageFor(new ApiError('UPGRADE_REQUIRED', 426, 'x'))).toBe('error.upgradeRequired');
    expect(messageFor(new ApiError('INTERNAL', 500, 'x'))).toBe('error.generic');
    expect(messageFor(new Error('boom'))).toBe('error.generic');
  });
  it('network wins over a screen-specific message', () => {
    expect(messageFor(new ApiError('NETWORK', 0, 'x'), { CODE_INVALID: 'pair.error.invalid' })).toBe('error.network');
  });
});
