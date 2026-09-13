import { describe, expect, it } from 'vitest';
import { findPeak, previousPeriod, queryOverview } from '../../src/server/db/queries/overview.js';
import { querySeries, TOP_PROJECTS } from '../../src/server/db/queries/series.js';
import { projectIdFor } from '../../src/server/db/session-merge.js';
import { OTHER_COLOR, PROJECT_PALETTE } from '../../src/shared/models.js';
import { createTestDb } from '../helpers/db.js';
import { ALPHA, BETA, makeRow, range, seed, seedScenario } from '../helpers/seed.js';

function scenario() {
  const { db, repos } = createTestDb();
  seedScenario(repos);
  return db;
}

const round = (matrix: readonly (readonly number[])[]) => matrix.map((row) => row.map((v) => Math.round(v * 1e9) / 1e9));

describe('querySeries by day', () => {
  it('stacks by model with zero-filled buckets', () => {
    const series = querySeries(scenario(), range('2026-09-09', '2026-09-11'), { bucket: 'day', stack: 'model', timeZone: 'UTC' });
    expect(series.buckets).toEqual(['2026-09-09', '2026-09-10', '2026-09-11']);
    expect(series.keys.map((k) => [k.key, k.label])).toEqual([
      ['claude-fable-5-1', 'fable-5.1'],
      ['claude-opus-5', 'opus-5'],
      ['claude-sonnet-5', 'sonnet-5'],
      ['claude-mystery', 'mystery'],
    ]);
    expect(round(series.cost)).toEqual([
      [0, 0, 0.85],
      [0, 0.062625, 0],
      [0.001, 0.01, 0],
      [0, 0, 0],
    ]);
    expect(series.tokens).toEqual([
      [0, 0, 77_000],
      [0, 13_300, 0],
      [100, 1_000, 0],
      [0, 0, 500],
    ]);
  });

  it('stacks by token type', () => {
    const series = querySeries(scenario(), range('2026-09-10', '2026-09-10'), { bucket: 'day', stack: 'type', timeZone: 'UTC' });
    expect(series.keys.map((k) => k.key)).toEqual(['cache_read', 'cache_write', 'output', 'input']);
    expect(round(series.cost)).toEqual([[0.005], [0.002625], [0.06], [0.005]]);
    expect(series.tokens).toEqual([[10_000], [300], [3_000], [1_000]]);
  });

  it('stacks by project and folds sessions without a project into other', () => {
    const series = querySeries(scenario(), range('2026-09-09', '2026-09-11'), { bucket: 'day', stack: 'project', timeZone: 'UTC' });
    expect(series.keys).toEqual([
      { key: projectIdFor(BETA), label: 'dev/beta', color: PROJECT_PALETTE[0] },
      { key: projectIdFor(ALPHA), label: 'dev/alpha', color: PROJECT_PALETTE[1] },
      { key: 'other', label: 'other', color: OTHER_COLOR },
    ]);
    expect(round(series.cost)).toEqual([
      [0, 0, 0.85],
      [0, 0.072625, 0],
      [0.001, 0, 0],
    ]);
  });

  it('keeps only the top projects and sums the rest into other', () => {
    const { db, repos } = createTestDb();
    const count = TOP_PROJECTS + 2;
    seed(repos, {
      rows: Array.from({ length: count }, (_, i) => makeRow({ sessionId: `s${i}`, output: (i + 1) * 1_000 })),
      sessions: Array.from({ length: count }, (_, i) => ({ sessionId: `s${i}`, cwd: `/work/p${i}` })),
    });
    const series = querySeries(db, range('2026-09-10', '2026-09-10'), { bucket: 'day', stack: 'project', timeZone: 'UTC' });
    expect(series.keys).toHaveLength(TOP_PROJECTS + 1);
    expect(series.keys.at(-1)?.key).toBe('other');
    expect(series.tokens.at(-1)).toEqual([1_000 + 2_000]);
  });
});

describe('querySeries by hour', () => {
  it('covers every UTC hour of the day', () => {
    const series = querySeries(scenario(), range('2026-09-10', '2026-09-10'), { bucket: 'hour', stack: 'model', timeZone: 'UTC' });
    expect(series.buckets).toHaveLength(24);
    expect(series.buckets[0]).toBe('2026-09-10T00:00');
    expect(series.buckets[23]).toBe('2026-09-10T23:00');
    const opus = series.keys.findIndex((k) => k.key === 'claude-opus-5');
    const sonnet = series.keys.findIndex((k) => k.key === 'claude-sonnet-5');
    expect(series.cost[opus]?.[10]).toBeCloseTo(0.062625, 10);
    expect(series.cost[sonnet]?.[11]).toBeCloseTo(0.01, 10);
  });

  it('labels hours in the configured time zone', () => {
    const series = querySeries(scenario(), range('2026-09-10', '2026-09-10'), {
      bucket: 'hour',
      stack: 'model',
      timeZone: 'Europe/Berlin',
    });
    expect(series.buckets).toHaveLength(24);
    expect(series.buckets[0]).toBe('2026-09-10T00:00');
    const opus = series.keys.findIndex((k) => k.key === 'claude-opus-5');
    expect(series.cost[opus]?.[12]).toBeCloseTo(0.062625, 10);
  });

  it('aligns hour buckets to local hours in half-hour offset zones', () => {
    const series = querySeries(scenario(), range('2026-09-10', '2026-09-10'), { bucket: 'hour', stack: 'model', timeZone: 'Asia/Kolkata' });
    expect(series.buckets).toHaveLength(24);
    expect(series.buckets[0]).toBe('2026-09-10T00:00');
    expect(series.buckets[15]).toBe('2026-09-10T15:00');
    const opus = series.keys.findIndex((k) => k.key === 'claude-opus-5');
    expect(series.cost[opus]?.[15]).toBeCloseTo(0.062625, 10);
  });

  it('puts a row from the middle of an hour into that hour', () => {
    const { db, repos } = createTestDb();
    seed(repos, { rows: [makeRow({ ts: Date.parse('2026-09-10T10:30:00Z'), output: 1_000 })] });
    const series = querySeries(db, range('2026-09-10', '2026-09-10'), { bucket: 'hour', stack: 'model', timeZone: 'UTC' });
    expect(series.tokens[0]?.[10]).toBe(1_000);
  });

  it('sums huge token counts per bucket without an integer overflow', () => {
    const { db, repos } = createTestDb();
    seed(repos, { rows: [makeRow({ messageId: 'h1', input: 5e18 }), makeRow({ messageId: 'h2', input: 5e18 })] });
    const filter = range('2026-09-10', '2026-09-10');
    const byModel = querySeries(db, filter, { bucket: 'hour', stack: 'model', timeZone: 'UTC' });
    const byType = querySeries(db, filter, { bucket: 'hour', stack: 'type', timeZone: 'UTC' });
    expect(byModel.tokens[0]?.[10]).toBe(1e19);
    expect(byType.tokens[byType.keys.findIndex((key) => key.key === 'input')]?.[10]).toBe(1e19);
  });

  it('labels both repeated hours of the fall-back day with their UTC offsets', () => {
    const { db, repos } = createTestDb();
    // Kyiv leaves summer time at 01:00Z on 2026-10-25: local 03:00-04:00 happens at +03:00, then again at +02:00.
    seed(repos, {
      rows: [
        makeRow({ messageId: 'dst-1', ts: Date.parse('2026-10-25T00:30:00Z'), localDay: '2026-10-25', output: 1_000 }),
        makeRow({ messageId: 'dst-2', ts: Date.parse('2026-10-25T01:30:00Z'), localDay: '2026-10-25', output: 2_000 }),
      ],
    });
    const series = querySeries(db, range('2026-10-25', '2026-10-25'), { bucket: 'hour', stack: 'model', timeZone: 'Europe/Kyiv' });
    expect(series.buckets).toHaveLength(25);
    expect(series.buckets.slice(2, 6)).toEqual([
      '2026-10-25T02:00',
      '2026-10-25T03:00+03:00',
      '2026-10-25T03:00+02:00',
      '2026-10-25T04:00',
    ]);
    expect(series.buckets.filter((label) => label.length > 16)).toHaveLength(2);
    expect(series.tokens[0]?.slice(2, 6)).toEqual([0, 1_000, 2_000, 0]);
  });

  it('produces 23 buckets on the spring-forward day', () => {
    const { db } = createTestDb();
    const series = querySeries(db, range('2026-03-29', '2026-03-29'), { bucket: 'hour', stack: 'type', timeZone: 'Europe/Berlin' });
    expect(series.buckets).toHaveLength(23);
  });
});

describe('overview composition', () => {
  it('computes range, averages, peak and hides an uncovered previous period', () => {
    const overview = queryOverview(scenario(), range('2026-09-10', '2026-09-11'), {
      bucket: 'day',
      stack: 'model',
      timeZone: 'UTC',
      dataFirstDay: '2026-09-09',
    });
    expect(overview.range).toEqual({ from: '2026-09-10', to: '2026-09-11', days: 2, bucket: 'day' });
    expect(overview.totals.avgCostPerDay).toBeCloseTo(0.922625 / 2, 10);
    expect(overview.totals.peak).toEqual({ bucket: '2026-09-11', cost: expect.closeTo(0.85, 10) });
    expect(overview.totals.prevPeriodCost).toBeNull();
    expect(overview.byModel).toHaveLength(4);
    expect(overview.byProject).toHaveLength(2);
  });

  it('reports the previous period cost when it is fully covered', () => {
    const overview = queryOverview(scenario(), range('2026-09-11', '2026-09-11'), {
      bucket: 'day',
      stack: 'model',
      timeZone: 'UTC',
      dataFirstDay: '2026-09-09',
    });
    expect(overview.totals.prevPeriodCost).toBeCloseTo(0.072625, 10);
  });

  it('returns no peak when there is no usage', () => {
    const { db } = createTestDb();
    const overview = queryOverview(db, range('2026-09-10', '2026-09-10'), {
      bucket: 'day',
      stack: 'model',
      timeZone: 'UTC',
      dataFirstDay: null,
    });
    expect(overview.totals.peak).toBeNull();
    expect(findPeak(overview.series)).toBeNull();
  });

  it('computes the previous period of equal length', () => {
    expect(previousPeriod(range('2026-09-10', '2026-09-11'))).toMatchObject({ from: '2026-09-08', to: '2026-09-09' });
  });
});
