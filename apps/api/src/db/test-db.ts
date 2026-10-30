// Integration-test helper: a freshly migrated med_test database (docker compose up -d --wait).
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is not set (see apps/api/.env.example)');
  return url;
}

export async function resetTestDb() {
  const made = createDb(testDatabaseUrl());
  await made.db.execute(sql`drop schema if exists public cascade`);
  await made.db.execute(sql`drop schema if exists drizzle cascade`);
  await made.db.execute(sql`create schema public`);
  await migrate(made.db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  return made;
}
