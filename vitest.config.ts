import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 2,
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
