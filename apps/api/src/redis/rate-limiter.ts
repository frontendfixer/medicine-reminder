import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ApiException } from '../common/api-exception.js';
import { REDIS } from './redis.constants.js';

interface Limiter extends Redis {
  // KEYS[1] counter; ARGV[1] window in ms. Returns [count, ttl ms].
  rateHit(key: string, windowMs: number): Promise<[number, number]>;
}

// Fixed-window counters. The window starts at the first hit; INCR and PEXPIRE run atomically in Lua.
@Injectable()
export class RateLimiter {
  private readonly redis: Limiter;

  constructor(@Inject(REDIS) redis: Redis) {
    redis.defineCommand('rateHit', {
      numberOfKeys: 1,
      lua: `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}`,
    });
    this.redis = redis as Limiter;
  }

  // Counts one hit; throws RATE_LIMITED (with Retry-After) once `limit` is exceeded within the window.
  async hit(key: string, limit: number, windowMs: number): Promise<void> {
    const [count, ttlMs] = await this.redis.rateHit(`rl:${key}`, windowMs);
    if (count > limit) throw rateLimited(Math.max(ttlMs, 1000));
  }
}

export function rateLimited(retryAfterMs: number): ApiException {
  return new ApiException('RATE_LIMITED', 'Too many attempts. Try again later.', {}, Math.ceil(retryAfterMs / 1000));
}
