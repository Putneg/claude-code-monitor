import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    restoreMocks: true,
    unstubGlobals: true,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'acceptance',
          include: ['tests/acceptance/**/*.test.ts'],
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
    ],
    // Coverage is measured on the server, the shared code and the dashboard's DOM-free logic (src/web/lib). Left out on purpose:
    // - the Svelte components (src/web/**/*.svelte) and src/web/main.ts: the Playwright suite (pnpm test:e2e) covers them;
    // - src/server/main.ts: the process entry point; its shutdown logic lives in shutdown.ts, which is unit-tested;
    // - src/server/logger.ts: a thin wrapper around pino;
    // - src/server/pricing/snapshot.ts: generated price data (pnpm update-prices).
    coverage: {
      provider: 'v8',
      include: ['src/server/**/*.ts', 'src/shared/**/*.ts', 'src/web/lib/**/*.ts'],
      exclude: ['src/server/main.ts', 'src/server/logger.ts', 'src/server/pricing/snapshot.ts'],
      reporter: ['text', 'html'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
