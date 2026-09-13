import { describe, expect, it } from 'vitest';
import { buildWhere } from '../../src/server/db/queries/filter-sql.js';
import { queryOverview } from '../../src/server/db/queries/overview.js';
import { queryByModel, queryByProject, queryPeriodCost, queryTotals } from '../../src/server/db/queries/totals.js';
import { projectIdFor } from '../../src/server/db/session-merge.js';
import { createTestDb } from '../helpers/db.js';
import { ALPHA, BETA, makeRow, range, seed, seedScenario } from '../helpers/seed.js';

function scenario() {
  const { db, repos } = createTestDb();
  seedScenario(repos);
  return db;
}

describe('buildWhere', () => {
  it('always filters by day and adds IN lists when present', () => {
    expect(buildWhere(range('2026-09-01', '2026-09-02'))).toEqual({
      sql: 'local_day BETWEEN @from AND @to',
      params: { from: '2026-09-01', to: '2026-09-02' },
    });
    const where = buildWhere(range('2026-09-01', '2026-09-02', { models: ['a', 'b'], projects: ['p'] }), 'c');
    expect(where.sql).toBe('c.local_day BETWEEN @from AND @to AND c.model IN (@model0, @model1) AND c.project_id IN (@project0)');
    expect(where.params).toEqual({ from: '2026-09-01', to: '2026-09-02', model0: 'a', model1: 'b', project0: 'p' });
  });
});

describe('queryTotals', () => {
  it('sums tokens and costs by type', () => {
    const totals = queryTotals(scenario(), range('2026-09-10', '2026-09-11'));
    expect(totals.cost.total).toBeCloseTo(0.922625, 10);
    expect(totals.cost.input).toBeCloseTo(0.755, 10);
    expect(totals.cost.output).toBeCloseTo(0.16, 10);
    expect(totals.cost.cacheRead).toBeCloseTo(0.005, 10);
    expect(totals.cost.cacheWrite).toBeCloseTo(0.002625, 10);
    expect(totals.tokens).toEqual({ input: 76_000, output: 5_500, cacheRead: 10_000, cacheWrite5m: 100, cacheWrite1h: 200 });
    expect(totals.tokensTotal).toBe(91_800);
    expect(totals).toMatchObject({ sessions: 2, projects: 2 });
    expect(totals.subagentCost).toBeCloseTo(0.01, 10);
    expect(totals.advisorCost).toBeCloseTo(0.85, 10);
  });

  it('applies model and project filters', () => {
    const db = scenario();
    expect(queryTotals(db, range('2026-09-10', '2026-09-11', { models: ['claude-opus-5'] })).cost.total).toBeCloseTo(0.062625, 10);
    const beta = queryTotals(db, range('2026-09-09', '2026-09-11', { projects: [projectIdFor(BETA)] }));
    expect(beta.cost.total).toBeCloseTo(0.85, 10);
    expect(beta.sessions).toBe(1);
  });

  it('returns zeros for an empty range', () => {
    const totals = queryTotals(scenario(), range('2026-01-01', '2026-01-02'));
    expect(totals.cost.total).toBe(0);
    expect(totals.tokensTotal).toBe(0);
    expect(totals.sessions).toBe(0);
  });
});

describe('queryByModel', () => {
  it('orders models by cost and derives share and effective price', () => {
    const models = queryByModel(scenario(), range('2026-09-10', '2026-09-11'), 0.922625);
    expect(models.map((m) => [m.model, m.label, m.priced])).toEqual([
      ['claude-fable-5-1', 'fable-5.1', true],
      ['claude-opus-5', 'opus-5', true],
      ['claude-sonnet-5', 'sonnet-5', true],
      ['claude-mystery', 'mystery', false],
    ]);
    const opus = models[1]!;
    expect(opus.tokensTotal).toBe(13_300);
    expect(opus.share).toBeCloseTo(0.062625 / 0.922625, 10);
    expect(opus.costPerMTok).toBeCloseTo(0.062625 / 0.0133, 8);
    expect(opus.color).toBe('#FFB000');
    expect(models[3]).toMatchObject({ cost: 0, costPerMTok: null });
  });
});

describe('queryByProject', () => {
  it('groups by project and skips sessions without a project', () => {
    const projects = queryByProject(scenario(), range('2026-09-09', '2026-09-11'));
    expect(projects).toEqual([
      { id: projectIdFor(BETA), path: BETA, label: 'dev/beta', tokensTotal: 77_500, cost: expect.closeTo(0.85, 10), sessions: 1 },
      { id: projectIdFor(ALPHA), path: ALPHA, label: 'dev/alpha', tokensTotal: 14_300, cost: expect.closeTo(0.072625, 10), sessions: 1 },
    ]);
  });
});

describe('queryPeriodCost', () => {
  it('sums cost for a range', () => {
    expect(queryPeriodCost(scenario(), range('2026-09-09', '2026-09-09'))).toBeCloseTo(0.001, 10);
  });

  it('returns 0 for a range without usage', () => {
    expect(queryPeriodCost(scenario(), range('2026-01-01', '2026-01-01'))).toBe(0);
  });
});

describe('subagent share', () => {
  it('counts sidechain rows with or without an agent id, and rows with an agent id', () => {
    const { db, repos } = createTestDb();
    seed(repos, {
      rows: [
        makeRow({ messageId: 'main', output: 1_000 }),
        makeRow({ messageId: 'in-file-task', isSidechain: true, agentId: null, output: 2_000 }),
        makeRow({ messageId: 'agent', agentId: 'agent-1', output: 4_000 }),
      ],
    });
    const totals = queryTotals(db, range('2026-09-10', '2026-09-10'));
    expect(totals.cost.total).toBeCloseTo(0.175, 10);
    expect(totals.subagentCost).toBeCloseTo(0.15, 10);
  });
});

describe('web search', () => {
  it('adds the per-request fee to the cost and keeps it out of the price per million tokens', () => {
    const { db, repos } = createTestDb();
    seed(repos, {
      rows: [
        makeRow({ messageId: 'w1', output: 1_000_000, webSearchRequests: 5, webFetchRequests: 2 }),
        makeRow({ messageId: 'w2', model: 'claude-mystery', webSearchRequests: 1 }),
      ],
    });
    const filter = range('2026-09-10', '2026-09-10');
    const totals = queryTotals(db, filter);
    expect(totals).toMatchObject({ webSearchRequests: 6, webFetchRequests: 2 });
    expect(totals.cost.webSearch).toBeCloseTo(0.06, 10);
    expect(totals.cost.total).toBeCloseTo(25.06, 10);
    const [opus, mystery] = queryByModel(db, filter, totals.cost.total);
    expect(opus).toMatchObject({ model: 'claude-opus-5', cost: expect.closeTo(25.05, 10), costPerMTok: expect.closeTo(25, 10) });
    expect(mystery).toMatchObject({ model: 'claude-mystery', priced: false, cost: expect.closeTo(0.01, 10), costPerMTok: null });
  });

  it('reports no requests and no fee without web search', () => {
    expect(queryTotals(scenario(), range('2026-09-10', '2026-09-11'))).toMatchObject({
      webSearchRequests: 0,
      webFetchRequests: 0,
      cost: { webSearch: 0 },
    });
  });
});

describe('overflow safety', () => {
  it('sums huge token counts without an integer overflow', () => {
    const { db, repos } = createTestDb();
    seed(repos, {
      rows: [makeRow({ messageId: 'h1', sessionId: 'huge', input: 5e18 }), makeRow({ messageId: 'h2', sessionId: 'huge', input: 5e18 })],
      sessions: [{ sessionId: 'huge', cwd: ALPHA }],
    });
    const overview = queryOverview(db, range('2026-09-10', '2026-09-10'), {
      bucket: 'day',
      stack: 'model',
      timeZone: 'UTC',
      dataFirstDay: '2026-09-10',
    });
    expect(overview.totals.tokens.input).toBe(1e19);
    expect(Number.isFinite(overview.totals.cost.total)).toBe(true);
    expect(overview.byModel[0]?.tokensTotal).toBe(1e19);
    expect(overview.byProject[0]?.tokensTotal).toBe(1e19);
  });
});
