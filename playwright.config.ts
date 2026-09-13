import { defineConfig, devices } from '@playwright/test';

/** Port of the E2E fixture server: 8740 unless E2E_PORT is set. It is passed on to the server through webServer.env. */
const RAW_PORT = process.env.E2E_PORT ?? '8740';
// Digits only: Number() alone would also accept "0x2224", "8.74e3" and "8740.0".
const PORT = /^\d+$/.test(RAW_PORT) ? Number(RAW_PORT) : Number.NaN;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error(`E2E_PORT must be an integer from 1 to 65535, got "${process.env.E2E_PORT}"`);
}

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    timezoneId: 'UTC',
    locale: 'en-US',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
  webServer: {
    command: 'node --import tsx scripts/e2e-server.ts',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
