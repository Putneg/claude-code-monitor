import { afterEach, describe, expect, it } from 'vitest';
import { queryFilters } from '../../src/server/db/queries/filters.js';
import { queryTotals } from '../../src/server/db/queries/totals.js';
import { runIngestCycle, type IngestDeps } from '../../src/server/ingest/ingestor.js';
import { createLogger } from '../../src/server/logger.js';
import { createPricingService } from '../../src/server/pricing/refresher.js';
import { StatusTracker } from '../../src/server/status.js';
import { createLocalDay } from '../../src/server/time.js';
import { createTestDb } from '../helpers/db.js';
import { assistantLine } from '../helpers/records.js';
import { range, TEST_PRICES } from '../helpers/seed.js';
import { createTree, type Tree } from '../helpers/tree.js';

let tree: Tree;
afterEach(() => tree.cleanup());

/** Two transcript files; the opus file sorts first because its mtime is older. */
function setup() {
  tree = createTree();
  const { db, repos } = createTestDb();
  const deps: IngestDeps = {
    db,
    repos,
    roots: [tree.root],
    toLocalDay: createLocalDay('UTC'),
    status: new StatusTracker(() => Date.parse('2026-09-11T00:00:00Z')),
    logger: createLogger('silent'),
  };
  const line = (messageId: string, sessionId: string, model: string): string =>
    assistantLine({
      messageId,
      model,
      sessionId,
      timestamp: '2026-09-10T10:00:00.000Z',
      usage: { output: 100, cacheRead: 1_000 },
    });
  tree.write('p/s1.jsonl', [line('m1', 's1', 'claude-opus-5')]);
  tree.write('p/s2.jsonl', [line('m2', 's2', 'claude-sonnet-5'), line('m3', 's2', 'claude-sonnet-5')]);
  tree.setMtime('p/s1.jsonl', new Date('2026-09-01T00:00:00Z'));
  tree.setMtime('p/s2.jsonl', new Date('2026-09-02T00:00:00Z'));
  return { db, repos, deps };
}

describe('IngestDeps.onFileCommitted', () => {
  it('reports the models of each file right after that file is committed', async () => {
    const { deps, repos } = setup();
    const calls: { models: string[]; committedFiles: number }[] = [];
    await runIngestCycle({
      ...deps,
      onFileCommitted: (models) => {
        calls.push({ models: [...models], committedFiles: repos.files.count() });
      },
    });
    expect(calls).toEqual([
      { models: ['claude-opus-5'], committedFiles: 1 },
      { models: ['claude-sonnet-5'], committedFiles: 2 },
    ]);
  });

  it('is not called for a file whose rows were rolled back', async () => {
    const { deps, repos } = setup();
    const failingUsage = {
      ...repos.usage,
      upsert: (row: Parameters<typeof repos.usage.upsert>[0]) => {
        if (row.model === 'claude-sonnet-5') throw new Error('boom');
        repos.usage.upsert(row);
      },
    };
    const reported: string[] = [];
    await runIngestCycle({
      ...deps,
      repos: { ...repos, usage: failingUsage },
      onFileCommitted: (models) => {
        reported.push(...models);
      },
    });
    expect(reported).toEqual(['claude-opus-5']);
  });

  it('prices the models of a committed file before the cycle ends', async () => {
    const { db, repos, deps } = setup();
    const pricing = createPricingService({
      prices: repos.prices,
      fetchPayload: async () => ({}),
      snapshot: { fetchedAt: '2026-09-01T00:00:00.000Z', prices: TEST_PRICES },
      logger: createLogger('silent'),
      now: () => Date.parse('2026-09-11T00:00:00Z'),
      refreshMs: 86_400_000,
      retryMs: 3_600_000,
    });
    pricing.ensureLoaded();
    const result = await runIngestCycle({
      ...deps,
      onFileCommitted: (models) => pricing.ensureMapped(models),
      shouldStop: () => repos.files.count() >= 1,
    });
    expect(result.files).toBe(1);
    expect(queryFilters(db, repos).models).toEqual([expect.objectContaining({ id: 'claude-opus-5', priced: true })]);
    // 100 output x $25/Mtok + 1,000 cache read x $0.50/Mtok
    expect(queryTotals(db, range('2026-09-10', '2026-09-10')).cost.total).toBeCloseTo(0.003, 12);
  });
});
