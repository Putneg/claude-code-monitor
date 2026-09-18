import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_SESSION_FOLDERS } from '../src/server/config.js';
import { createLogger } from '../src/server/logger.js';
import { DEFAULT_WEB_ROOT, startService } from '../src/server/service.js';
import { writeCodexFixture } from '../tests/e2e/fixture-codex.js';
import { writeClaudeLimitsFixture } from '../tests/e2e/fixture-limits.js';
import { E2E_NOW_MS, writeFixture } from '../tests/e2e/fixture.js';

/** 'claude' serves the Claude Code fixture alone; 'mixed' adds a Codex home. */
const FIXTURE = process.env.E2E_FIXTURE ?? 'claude';
if (FIXTURE !== 'claude' && FIXTURE !== 'mixed') throw new Error(`E2E_FIXTURE must be claude or mixed, got ${FIXTURE}`);
// One folder per fixture: both servers start at once, and each clears only its own data.
const DATA_DIR = fileURLToPath(new URL(`../.e2e-data/${FIXTURE}`, import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? '8740');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) throw new Error(`E2E_PORT must be a TCP port, got ${process.env.E2E_PORT}`);

if (!existsSync(join(DEFAULT_WEB_ROOT, 'index.html'))) {
  console.error('dist/web/index.html is missing: run "pnpm build:web" before starting the e2e server');
  process.exit(1);
}

// Playwright kills this process on Windows without a signal, so stale data is removed at start, not at exit.
rmSync(DATA_DIR, { recursive: true, force: true });
writeFixture(join(DATA_DIR, 'projects'));
// Without the mixed fixture the Codex home and the Claude limits file do not exist, which is how the dashboard sees a machine
// without Codex and without the status line tap.
const codexHome = join(DATA_DIR, 'codex');
const claudeLimitsFile = join(DATA_DIR, 'claude-code-monitor', 'rate-limits.json');
if (FIXTURE === 'mixed') {
  writeCodexFixture(codexHome);
  writeClaudeLimitsFixture(claudeLimitsFile);
}

// The pricing URL is unreachable on purpose (the embedded snapshot is used); warn-level logs would print a stack trace on every run.
const logger = createLogger('error');
const service = await startService(
  {
    port: PORT,
    host: '127.0.0.1',
    allowedHosts: [],
    projectsDirs: [join(DATA_DIR, 'projects')],
    codexRoots: CODEX_SESSION_FOLDERS.map((folder) => join(codexHome, folder)),
    claudeLimitsFile,
    dbPath: join(DATA_DIR, 'monitor.db'),
    scanIntervalMs: 60_000,
    timeZone: 'UTC',
    pricingUrl: 'http://127.0.0.1:9/unreachable.json',
    pricingRefreshMs: 86_400_000,
    logLevel: 'error',
  },
  logger,
  // "today" and the presets are frozen the day after the fixture, so their bounds are exact; sync and health times stay real.
  { webRoot: DEFAULT_WEB_ROOT, calendarNow: () => E2E_NOW_MS },
);

const shutdown = (): void => {
  service.stop().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error({ err: error }, 'e2e server stop failed');
      process.exit(1);
    },
  );
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
