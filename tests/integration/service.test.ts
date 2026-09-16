import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FiltersResponse, OverviewResponse, StatusResponse } from '../../src/shared/api.js';
import type { Config } from '../../src/server/config.js';
import { openDatabase } from '../../src/server/db/connection.js';
import { migrate } from '../../src/server/db/migrations.js';
import { createLogger } from '../../src/server/logger.js';
import { DEFAULT_WEB_ROOT, startService, type RunningService } from '../../src/server/service.js';
import { assistantLine, titleLine } from '../helpers/records.js';
import { createTree, type Tree } from '../helpers/tree.js';

let tree: Tree | undefined;
let service: RunningService | undefined;

afterEach(async () => {
  await service?.stop();
  service = undefined;
  tree?.cleanup();
  tree = undefined;
});

async function waitForSync(base: string): Promise<StatusResponse> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = (await (await fetch(`${base}/api/status`)).json()) as StatusResponse;
    if (status.sync.lastSyncAt !== null) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('ingest cycle did not complete in time');
}

function testConfig(root: string, projectsDir: string, name: string): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    allowedHosts: [],
    projectsDirs: [projectsDir],
    codexRoots: [],
    dbPath: join(root, name, 'monitor.db'),
    scanIntervalMs: 60_000,
    timeZone: 'UTC',
    pricingUrl: 'http://127.0.0.1:9/unreachable.json',
    pricingRefreshMs: 86_400_000,
    logLevel: 'silent',
  };
}

describe('startService', () => {
  it('backfills transcripts, serves the API and stops cleanly', async () => {
    tree = createTree();
    tree.write('projects/-home-dev-alpha/s1.jsonl', [
      assistantLine({
        messageId: 'm1',
        model: 'claude-opus-5',
        sessionId: 's1',
        timestamp: '2026-09-10T10:00:00.000Z',
        usage: { input: 10, output: 1_000, cacheRead: 5_000, cacheWrite1h: 100, webSearchRequests: 2 },
      }),
      titleLine('s1', 'Service smoke test'),
    ]);
    const config = testConfig(tree.root, join(tree.root, 'projects'), 'data');
    service = await startService(config, createLogger('silent'), { webRoot: null });
    const base = `http://127.0.0.1:${service.port}`;

    const status = await waitForSync(base);
    expect(status.sources[0]).toMatchObject({ ok: true, files: 1, client: 'claude', required: true, present: true });
    expect(status.data.rows).toBe(1);

    const overview = (await (await fetch(`${base}/api/overview?from=2026-09-10&to=2026-09-10`)).json()) as OverviewResponse;
    expect(overview.totals.tokensTotal).toBe(6_110);
    expect(overview.totals.cost.total).toBeGreaterThan(0);
    expect(overview.totals).toMatchObject({ webSearchRequests: 2, webFetchRequests: 0 });
    expect(overview.totals.cost.webSearch).toBeCloseTo(0.02, 10);

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);

    await service.stop();
    service = undefined;
    expect(existsSync(config.dbPath)).toBe(true);
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });

  it('rebuilds the price registry from stored usage after an interrupted run', async () => {
    tree = createTree();
    const emptyRoot = tree.path('empty-projects');
    mkdirSync(emptyRoot, { recursive: true });
    const config = testConfig(tree.root, emptyRoot, 'data');
    const seedDb = openDatabase(config.dbPath);
    migrate(seedDb);
    seedDb
      .prepare(
        `INSERT INTO usage (message_id, request_id, kind, seq, session_id, agent_id, is_sidechain, model, speed, ts, local_day,
                            input, output, cache_read, cache_write_5m, cache_write_1h)
         VALUES ('m1', 'req', 'primary', 0, 'session-a', NULL, 0, 'claude-opus-5', 'standard', 0, '2026-09-10', 1000, 2000, 10000, 100, 200)`,
      )
      .run();
    seedDb.close();

    service = await startService(config, createLogger('silent'), { webRoot: null });
    const base = `http://127.0.0.1:${service.port}`;

    const filters = (await (await fetch(`${base}/api/filters`)).json()) as FiltersResponse;
    expect(filters.models.map((m) => m.id)).toContain('claude-opus-5');
  });

  it('takes "today" and the default range from the calendar clock while sync times stay real', async () => {
    tree = createTree();
    tree.write('projects/-home-dev-alpha/s1.jsonl', [
      assistantLine({
        messageId: 'm1',
        model: 'claude-opus-5',
        sessionId: 's1',
        timestamp: '2026-03-10T10:00:00.000Z',
        usage: { input: 10, output: 1_000 },
      }),
    ]);
    const config = testConfig(tree.root, join(tree.root, 'projects'), 'data');
    service = await startService(config, createLogger('silent'), {
      webRoot: null,
      calendarNow: () => Date.parse('2026-03-15T12:00:00.000Z'),
    });
    const base = `http://127.0.0.1:${service.port}`;

    const status = await waitForSync(base);
    expect(status.now).toBe('2026-03-15T12:00:00.000Z');
    expect(status.today).toBe('2026-03-15');
    // The sync time comes from the real clock, which is later than the frozen calendar.
    expect(Date.parse(status.sync.lastSyncAt ?? '')).toBeGreaterThan(Date.parse(status.now));

    const overview: unknown = await (await fetch(`${base}/api/overview`)).json();
    expect(overview).toMatchObject({
      range: { from: '2026-02-14', to: '2026-03-15', days: 30, bucket: 'day' },
      totals: { tokensTotal: 1_010 },
    });
  });

  it('serves the dashboard from <repo>/dist/web by default', () => {
    expect(relative(resolve('dist', 'web'), DEFAULT_WEB_ROOT)).toBe('');
  });

  it('releases everything it opened when the port is already taken', async () => {
    tree = createTree();
    const projects = tree.path('projects');
    mkdirSync(projects, { recursive: true });
    service = await startService(testConfig(tree.root, projects, 'first'), createLogger('silent'), { webRoot: null });
    const second = { ...testConfig(tree.root, projects, 'second'), port: service.port };

    await expect(startService(second, createLogger('silent'), { webRoot: null })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // On Windows an open SQLite handle makes this throw EBUSY, so it proves the second database was closed.
    expect(() => rmSync(dirname(second.dbPath), { recursive: true })).not.toThrow();
  });
});
