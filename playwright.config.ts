import { defineConfig, devices } from '@playwright/test';

/** A fixture server's port from the environment, or the fallback. It reaches the server through webServer.env. */
function portFrom(name: string, fallback: string): number {
  const raw = process.env[name] ?? fallback;
  // Digits only: Number() alone would also accept "0x2224", "8.74e3" and "8740.0".
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535, got "${process.env[name]}"`);
  }
  return port;
}

/** The Claude Code fixture (dashboard.spec.ts). */
const PORT = portFrom('E2E_PORT', '8740');
/** The Claude Code and Codex fixture (codex.spec.ts). */
const CODEX_PORT = portFrom('E2E_CODEX_PORT', '8741');
if (PORT === CODEX_PORT) throw new Error('E2E_PORT and E2E_CODEX_PORT must differ');

const browser = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } };

function fixtureServer(port: number, fixture: 'claude' | 'mixed') {
  return {
    command: 'node --import tsx scripts/e2e-server.ts',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(port), E2E_FIXTURE: fixture },
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  };
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
    trace: 'retain-on-failure',
    timezoneId: 'UTC',
    locale: 'en-US',
  },
  projects: [
    { name: 'chromium', testMatch: /dashboard\.spec\.ts$/, use: { ...browser, baseURL: `http://127.0.0.1:${PORT}` } },
    { name: 'codex', testMatch: /codex\.spec\.ts$/, use: { ...browser, baseURL: `http://127.0.0.1:${CODEX_PORT}` } },
  ],
  webServer: [fixtureServer(PORT, 'claude'), fixtureServer(CODEX_PORT, 'mixed')],
});
