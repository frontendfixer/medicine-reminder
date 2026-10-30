import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Hmac } from '../crypto/hmac.js';
import { REDIS } from '../redis/redis.constants.js';
import { rateLimited } from '../redis/rate-limiter.js';

export const FREE_ATTEMPTS = 5; // attempts before any delay
const BASE_DELAY_SECONDS = 30; // doubles with each further attempt
const MAX_DELAY_SECONDS = 15 * 60;
const MEMORY_SECONDS = 60 * 60; // consecutive attempts are forgotten after an hour without any

interface Throttle extends Redis {
  // KEYS: attempts counter, block flag. Returns [allowed (1/0), retry-after ms].
  loginReserve(attempts: string, blocked: string, free: number, base: number, max: number, memory: number): Promise<[number, number]>;
}

// Per-account progressive delay for sign-in attempts (D-095): no hard lockout, so a guesser slows to a crawl
// but the real owner can always get back in. Keyed by the email address, not the account, so an address with
// no account behaves exactly like one with an account (no enumeration).
//
// Every attempt is counted when it starts, atomically with the block check, so parallel guesses can't all
// slip through before the first failure is recorded. A successful sign-in resets the count.
@Injectable()
export class LoginThrottle {
  private readonly redis: Throttle;

  constructor(
    @Inject(REDIS) redis: Redis,
    private readonly hmac: Hmac,
  ) {
    redis.defineCommand('loginReserve', {
      numberOfKeys: 2,
      lua: `local ttl = redis.call('PTTL', KEYS[2])
if ttl > 0 then return {0, ttl} end
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[4])
local free = tonumber(ARGV[1])
if n >= free then
  local delay = math.floor(math.min(tonumber(ARGV[2]) * 2 ^ (n - free), tonumber(ARGV[3])))
  redis.call('SET', KEYS[2], '1', 'EX', delay)
end
return {1, 0}`,
    });
    this.redis = redis as Throttle;
  }

  private keys(email: string) {
    const id = this.hmac.hex('login-throttle', email);
    return { attempts: `lt:attempts:${id}`, blocked: `lt:blocked:${id}` };
  }

  // Throws RATE_LIMITED while a delay is running, even if the password would have been right.
  async reserve(email: string): Promise<void> {
    const { attempts, blocked } = this.keys(email);
    const [allowed, retryMs] = await this.redis.loginReserve(attempts, blocked, FREE_ATTEMPTS, BASE_DELAY_SECONDS, MAX_DELAY_SECONDS, MEMORY_SECONDS);
    if (!allowed) throw rateLimited(retryMs);
  }

  async reset(email: string): Promise<void> {
    const { attempts, blocked } = this.keys(email);
    await this.redis.del(attempts, blocked);
  }
}
