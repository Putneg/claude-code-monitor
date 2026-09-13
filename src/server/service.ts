import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { Config } from './config.js';
import { openDatabase, type Db } from './db/connection.js';
import { migrate } from './db/migrations.js';
import { createRepos, type Repos } from './db/repos.js';
import { createApp } from './http/app.js';
import { runIngestCycle } from './ingest/ingestor.js';
import { createNotices } from './ingest/notices.js';
import type { Logger } from './logger.js';
import { createFetchPayload, createPricingService, PRICING_RETRY_MS, type PricingService } from './pricing/refresher.js';
import { PRICE_SNAPSHOT } from './pricing/snapshot.js';
import { startScheduler, type Scheduler } from './scheduler.js';
import { StatusTracker } from './status.js';
import { createLocalDay } from './time.js';
import { syncTimeZone } from './tz-sync.js';

export interface RunningService {
  readonly port: number;
  stop(): Promise<void>;
}

/** <repo>/dist/web from both src/server (tsx) and dist/server (built); Vite writes the dashboard there. */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../dist/web', import.meta.url));

/** /healthz reports 503 once ingest has made no progress for this many scan intervals. */
export const HEALTH_STALE_INTERVALS = 10;

function listen(app: Hono, config: Config, logger: Logger): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
      server.off('error', reject);
      server.on('error', (error: Error) => logger.error({ err: error }, 'http server error'));
      resolve({ server, port: info.port });
    });
    server.once('error', reject);
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function startPricing(config: Config, repos: Repos, logger: Logger): PricingService {
  const pricing = createPricingService({
    prices: repos.prices,
    fetchPayload: createFetchPayload(config.pricingUrl),
    snapshot: PRICE_SNAPSHOT,
    logger: logger.child({ module: 'pricing' }),
    now: Date.now,
    refreshMs: config.pricingRefreshMs,
    retryMs: PRICING_RETRY_MS,
  });
  pricing.ensureLoaded();
  pricing.start();
  return pricing;
}

/**
 * The ingest hook that maps a committed file's models to prices. The file's rows are already committed, so a mapping
 * failure is logged here rather than thrown into the ingestor, which would report the file as failed. Exported for tests.
 */
export function mapModelsOnCommit(pricing: Pick<PricingService, 'ensureMapped'>, logger: Logger): (models: ReadonlySet<string>) => void {
  return (models) => {
    try {
      pricing.ensureMapped(models);
    } catch (error) {
      logger.warn(
        { err: error, models: [...models] },
        'failed to map models to prices; they stay unpriced until another file or a restart maps them',
      );
    }
  };
}

interface IngestLoopDeps {
  readonly config: Config;
  readonly db: Db;
  readonly repos: Repos;
  readonly status: StatusTracker;
  readonly pricing: PricingService;
  readonly logger: Logger;
  readonly shouldStop: () => boolean;
}

function startIngest(deps: IngestLoopDeps): Scheduler {
  const { config, db, repos, status, pricing, shouldStop } = deps;
  const toLocalDay = createLocalDay(config.timeZone);
  const logger = deps.logger.child({ module: 'ingest' });
  // One Notices for the service's lifetime: a lasting problem is logged once, not every scan interval.
  const notices = createNotices();
  return startScheduler({
    intervalMs: config.scanIntervalMs,
    logger,
    task: async () => {
      const result = await runIngestCycle({
        db,
        repos,
        roots: config.projectsDirs,
        toLocalDay,
        status,
        logger,
        shouldStop,
        notices,
        onFileCommitted: mapModelsOnCommit(pricing, logger),
      });
      if (result.files > 0) {
        logger.info(
          { files: result.files, rows: result.rows, skipped: result.skipped, backfill: result.backfill },
          'ingest cycle complete',
        );
      }
    },
  });
}

/**
 * What stopAll touches; narrow so tests can pass plain fakes. The database is `{ close(): void }` rather than
 * `Pick<Db, 'close'>`, because better-sqlite3 declares `close(): this` and a fake cannot return a Database.
 */
export interface Background {
  readonly controller: AbortController;
  readonly scheduler: Pick<Scheduler, 'stop'>;
  readonly pricing: Pick<PricingService, 'stop'>;
  readonly db: { close(): void };
}

/**
 * Shutdown order: ingest (stops between files), pricing timers, HTTP server (when listening), database — closed even
 * when an earlier step fails. Exported for tests.
 */
export async function stopAll(background: Background, server: ServerType | null): Promise<void> {
  background.controller.abort();
  try {
    await background.scheduler.stop();
    background.pricing.stop();
    if (server !== null) await closeServer(server);
  } finally {
    background.db.close();
  }
}

/**
 * Cleans up after a failed listen and rethrows the listen error; a cleanup failure is logged, never allowed to
 * replace it. Exported for tests.
 */
export async function abortStart(background: Background, error: unknown, logger: Logger): Promise<never> {
  await stopAll(background, null).catch((cleanupError: unknown) => {
    logger.error({ err: cleanupError }, 'cleanup after a failed start failed');
  });
  throw error;
}

export interface ServiceOptions {
  /** Directory with the built dashboard; defaults to DEFAULT_WEB_ROOT, and null serves the API only. */
  readonly webRoot?: string | null;
  /** See ApiDeps.calendarNow: the clock behind "today", the presets and status.now. Defaults to the real clock. */
  readonly calendarNow?: () => number;
}

export async function startService(config: Config, logger: Logger, options: ServiceOptions = {}): Promise<RunningService> {
  const db = openDatabase(config.dbPath);
  migrate(db);
  const repos = createRepos(db);
  syncTimeZone(repos, config.timeZone, logger);
  const status = new StatusTracker();
  const pricing = startPricing(config, repos, logger);
  pricing.ensureMapped(repos.usage.distinctModels());
  const controller = new AbortController();
  const scheduler = startIngest({ config, db, repos, status, pricing, logger, shouldStop: () => controller.signal.aborted });
  const background: Background = { controller, scheduler, pricing, db };
  const app = createApp({
    db,
    repos,
    status,
    pricing,
    timeZone: config.timeZone,
    now: Date.now,
    calendarNow: options.calendarNow,
    logger: logger.child({ module: 'http' }),
    webRoot: options.webRoot === undefined ? DEFAULT_WEB_ROOT : options.webRoot,
    healthStaleMs: HEALTH_STALE_INTERVALS * config.scanIntervalMs,
    allowedHosts: config.allowedHosts,
  });
  const listening = await listen(app, config, logger).catch((error: unknown) => abortStart(background, error, logger));
  logger.info(
    { port: listening.port, host: config.host, sources: config.projectsDirs, tz: config.timeZone },
    'claude-code-monitor started',
  );
  return { port: listening.port, stop: () => stopAll(background, listening.server) };
}
