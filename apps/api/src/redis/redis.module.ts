import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { RateLimiter } from './rate-limiter.js';
import { REDIS } from './redis.constants.js';

// Redis holds only disposable state (rate-limit counters now, BullMQ triggers later): D-033.
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => {
        const url = process.env.REDIS_URL;
        if (!url) throw new Error('REDIS_URL is required');
        const redis = new Redis(url, { maxRetriesPerRequest: 2 });
        const log = new Logger('Redis');
        // Without a listener ioredis stays silent; log the error class only.
        redis.on('error', (e: Error) => log.error(`Redis error: ${e.name}`));
        return redis;
      },
    },
    RateLimiter,
  ],
  exports: [REDIS, RateLimiter],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
