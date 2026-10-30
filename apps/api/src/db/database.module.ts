import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { createDb, type Db } from './client.js';

export const DB = Symbol('DB');
const POOL = Symbol('DB_POOL');

@Global()
@Module({
  providers: [
    {
      provide: POOL,
      useFactory: () => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL is required');
        return createDb(url);
      },
    },
    { provide: DB, useFactory: (made: { db: Db }) => made.db, inject: [POOL] },
  ],
  exports: [DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly made: { pool: Pool }) {}

  async onApplicationShutdown(): Promise<void> {
    await this.made.pool.end();
  }
}
