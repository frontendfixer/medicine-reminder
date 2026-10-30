import { defineConfig } from 'vitest/config';

// Integration tests need the Postgres 18 container: `docker compose up -d --wait` from the repo root.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.int-spec.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
