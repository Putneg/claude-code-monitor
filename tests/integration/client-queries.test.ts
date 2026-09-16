import { describe, expect, it } from 'vitest';
import { queryFilters } from '../../src/server/db/queries/filters.js';
import { queryOverview } from '../../src/server/db/queries/overview.js';
import { querySeries } from '../../src/server/db/queries/series.js';
import { querySessions } from '../../src/server/db/queries/sessions.js';
import { queryByClient, queryTotals } from '../../src/server/db/queries/totals.js';
import type { PriceTable } from '../../src/server/pricing/types.js';
import { createTestDb } from '../helpers/db.js';
import { ALPHA, makeRow, range, seed, TEST_PRICES } from '../helpers/seed.js';

const PRICES: PriceTable = {
  ...TEST_PRICES,
  'gpt-5.6-sol': { input: 4e-6, output: 2e-5, cacheWrite5m: 5e-6, cacheWrite1h: 5e-6, cacheRead: 4e-7, fastMultiplier: 1 },
};
const DAY = range('2026-09-10', '2026-09-10');
const CLAUDE_COST = 1_000 * 2.5e-5;
const CODEX_COST = 1_000 * 4e-6 + 10_000 * 4e-7 + 500 * 2e-5;

function mixed() {
  const { db, repos } = createTestDb();
  seed(repos, {
    prices: PRICES,
    rows: [
      makeRow({ messageId: 'c1', sessionId: 'claude-1', model: 'claude-opus-5', output: 1_000 }),
      makeRow({
        messageId: 'resp_1',
        client: 'codex',
        sessionId: 'codex-1',
        model: 'gpt-5.6-sol',
        input: 1_000,
        cacheRead: 10_000,
        output: 500,
      }),
    ],
    sessions: [
      { sessionId: 'claude-1', cwd: ALPHA },
      { sessionId: 'codex-1', cwd: ALPHA },
    ],
  });
  return { db, repos };
}

describe('client dimension', () => {
  it('filters totals by client', () => {
    const { db } = mixed();
    expect(queryTotals(db, DAY).cost.total).toBeCloseTo(CLAUDE_COST + CODEX_COST, 12);
    expect(queryTotals(db, { ...DAY, clients: ['codex'] }).cost.total).toBeCloseTo(CODEX_COST, 12);
    expect(queryTotals(db, { ...DAY, clients: ['claude'] }).tokensTotal).toBe(1_000);
  });

  it('breaks cost and tokens down by client, most expensive first', () => {
    const { db } = mixed();
    const total = CLAUDE_COST + CODEX_COST;
    expect(queryByClient(db, DAY, total)).toEqual([
      {
        client: 'claude',
        label: 'claude code',
        color: '#FFB000',
        tokensTotal: 1_000,
        cost: expect.closeTo(CLAUDE_COST, 12),
        share: expect.closeTo(CLAUDE_COST / total, 12),
      },
      {
        client: 'codex',
        label: 'codex',
        color: '#10A37F',
        tokensTotal: 11_500,
        cost: expect.closeTo(CODEX_COST, 12),
        share: expect.closeTo(CODEX_COST / total, 12),
      },
    ]);
    expect(queryByClient(db, range('2026-01-01', '2026-01-01'), 0)).toEqual([]);
  });

  it('stacks the series by client', () => {
    const { db } = mixed();
    const series = querySeries(db, DAY, { bucket: 'day', stack: 'client', timeZone: 'UTC' });
    expect(series.stack).toBe('client');
    expect(series.keys).toEqual([
      { key: 'claude', label: 'claude code', color: '#FFB000' },
      { key: 'codex', label: 'codex', color: '#10A37F' },
    ]);
    expect(series.tokens).toEqual([[1_000], [11_500]]);
  });

  it('adds the client breakdown to the overview', () => {
    const { db } = mixed();
    const overview = queryOverview(db, DAY, { bucket: 'day', stack: 'model', timeZone: 'UTC', dataFirstDay: '2026-09-10' });
    expect(overview.byClient.map((item) => item.client)).toEqual(['claude', 'codex']);
  });

  it('reports the client of each session', () => {
    const { db } = mixed();
    const result = querySessions(db, DAY, { sort: 'cost', limit: 50 });
    expect(result.sessions.map((session) => [session.id, session.client])).toEqual([
      ['claude-1', 'claude'],
      ['codex-1', 'codex'],
    ]);
  });

  it('offers the clients that have data, in display order', () => {
    const { db, repos } = mixed();
    expect(queryFilters(db, repos).clients).toEqual([
      { id: 'claude', label: 'claude code', color: '#FFB000' },
      { id: 'codex', label: 'codex', color: '#10A37F' },
    ]);
    const empty = createTestDb();
    expect(queryFilters(empty.db, empty.repos).clients).toEqual([]);
  });
});
