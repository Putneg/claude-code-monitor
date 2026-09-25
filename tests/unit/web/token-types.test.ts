import { describe, expect, it } from 'vitest';
import { tokenInsights, tokenTypeRows } from '../../../src/web/lib/token-types.js';
import { makeOverview } from './fixtures.js';

describe('tokenTypeRows', () => {
  it('computes token and cost shares in the fixed order', () => {
    const rows = tokenTypeRows(makeOverview().totals);
    expect(rows.map((row) => row.key)).toEqual(['cache_read', 'cache_write', 'output', 'input']);
    expect(rows[0]).toEqual({
      key: 'cache_read',
      label: 'cache read',
      color: '#5FD7D7',
      tokens: 900,
      cost: 3,
      tokenShare: 0.72,
      costShare: 0.375,
    });
    expect(rows[1]).toMatchObject({ key: 'cache_write', tokens: 100, cost: 1.5 });
  });

  it('leaves the web search fee out of the token cost shares', () => {
    const base = makeOverview().totals;
    const rows = tokenTypeRows({ ...base, cost: { ...base.cost, webSearch: 2, total: base.cost.total + 2 }, webSearchRequests: 200 });
    expect(rows.reduce((sum, row) => sum + row.costShare, 0)).toBeCloseTo(1, 10);
    expect(rows[0]?.costShare).toBe(0.375);
  });

  it('returns zero shares for an empty period', () => {
    const empty = {
      ...makeOverview().totals,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0, total: 0 },
    };
    expect(tokenTypeRows(empty).every((row) => row.tokenShare === 0 && row.costShare === 0)).toBe(true);
  });
});

describe('tokenInsights', () => {
  it('compares token share with cost share for the cache types', () => {
    expect(tokenInsights(tokenTypeRows(makeOverview().totals))).toEqual([
      'cache reads = 72% of tokens but 38% of cost',
      'cache writes = 8% of tokens but 19% of cost',
    ]);
  });
});
