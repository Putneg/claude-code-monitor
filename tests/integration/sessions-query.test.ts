import { describe, expect, it } from 'vitest';
import { queryFilters } from '../../src/server/db/queries/filters.js';
import { querySessions } from '../../src/server/db/queries/sessions.js';
import { projectIdFor } from '../../src/server/db/session-merge.js';
import { createTestDb } from '../helpers/db.js';
import { ALPHA, BETA, makeRow, range, seed, seedScenario } from '../helpers/seed.js';

function scenario() {
  const { db, repos } = createTestDb();
  seedScenario(repos);
  return { db, repos };
}

const ALL = range('2026-09-09', '2026-09-11');

describe('querySessions', () => {
  it('lists sessions by cost with project, title and models', () => {
    const { db } = scenario();
    const result = querySessions(db, ALL, { sort: 'cost', limit: 50 });
    expect(result.total).toBe(3);
    expect(result.sessions.map((s) => s.id)).toEqual(['beta-1', 'alpha-1', 'orphan-1']);
    expect(result.sessions[1]).toEqual({
      id: 'alpha-1',
      title: 'Alpha feature',
      projectId: projectIdFor(ALPHA),
      projectLabel: 'dev/alpha',
      firstTs: '2026-09-10T10:00:00.000Z',
      lastTs: '2026-09-10T11:00:00.000Z',
      models: ['claude-opus-5', 'claude-sonnet-5'],
      tokensTotal: 14_300,
      cost: expect.closeTo(0.072625, 10),
      subagentCost: expect.closeTo(0.01, 10),
      client: 'claude',
    });
    expect(result.sessions[2]).toMatchObject({ id: 'orphan-1', title: null, projectId: null, projectLabel: null });
  });

  it('sorts by most recent activity', () => {
    const { db } = scenario();
    const result = querySessions(db, ALL, { sort: 'recent', limit: 50 });
    expect(result.sessions.map((s) => s.id)).toEqual(['beta-1', 'alpha-1', 'orphan-1']);
    const byRecent = querySessions(db, range('2026-09-09', '2026-09-10'), { sort: 'recent', limit: 50 });
    expect(byRecent.sessions.map((s) => s.id)).toEqual(['alpha-1', 'orphan-1']);
  });

  it('applies the limit but reports the full total', () => {
    const { db } = scenario();
    const result = querySessions(db, ALL, { sort: 'cost', limit: 1 });
    expect(result.total).toBe(3);
    expect(result.sessions).toHaveLength(1);
  });

  it('restricts rows and models to the filter', () => {
    const { db } = scenario();
    const result = querySessions(db, range('2026-09-09', '2026-09-11', { models: ['claude-sonnet-5'] }), { sort: 'cost', limit: 50 });
    expect(result.sessions.map((s) => [s.id, s.models])).toEqual([
      ['alpha-1', ['claude-sonnet-5']],
      ['orphan-1', ['claude-sonnet-5']],
    ]);
  });

  it('sums huge token counts without an integer overflow', () => {
    const { db, repos } = createTestDb();
    seed(repos, {
      rows: [makeRow({ messageId: 'h1', sessionId: 'huge', input: 5e18 }), makeRow({ messageId: 'h2', sessionId: 'huge', input: 5e18 })],
    });
    const result = querySessions(db, range('2026-09-10', '2026-09-10'), { sort: 'cost', limit: 50 });
    expect(result.sessions[0]).toMatchObject({ id: 'huge', tokensTotal: 1e19 });
  });

  it('returns an empty list for an empty range', () => {
    const { db } = scenario();
    expect(querySessions(db, range('2026-01-01', '2026-01-01'), { sort: 'cost', limit: 50 })).toEqual({ total: 0, sessions: [] });
  });
});

describe('queryFilters', () => {
  it('lists registered models, known projects and day bounds', () => {
    const { db, repos } = scenario();
    expect(queryFilters(db, repos)).toEqual({
      models: [
        { id: 'claude-fable-5-1', label: 'fable-5.1', color: '#7AA2F7', priced: true },
        { id: 'claude-mystery', label: 'mystery', color: expect.stringMatching(/^#[0-9A-F]{6}$/), priced: false },
        { id: 'claude-opus-5', label: 'opus-5', color: '#FFB000', priced: true },
        { id: 'claude-sonnet-5', label: 'sonnet-5', color: '#8BD450', priced: true },
      ],
      projects: [
        { id: projectIdFor(ALPHA), path: ALPHA, label: 'dev/alpha' },
        { id: projectIdFor(BETA), path: BETA, label: 'dev/beta' },
      ],
      clients: [{ id: 'claude', label: 'claude code', color: '#FFB000' }],
      bounds: { firstDay: '2026-09-09', lastDay: '2026-09-11' },
    });
  });
});
