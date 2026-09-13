import { describe, expect, it } from 'vitest';
import type { ProjectBreakdown, SessionSummary } from '../../../src/shared/api.js';
import { matchProjects, projectRows, sessionRows } from '../../../src/web/lib/tables.js';

const ALPHA: ProjectBreakdown = { id: 'p1', path: '/home/dev/alpha', label: 'dev/alpha', tokensTotal: 1_200_000, cost: 40, sessions: 3 };
const BETA: ProjectBreakdown = { id: 'p2', path: '/home/dev/beta', label: 'dev/beta', tokensTotal: 30_000, cost: 10, sessions: 1 };

describe('projectRows', () => {
  it('scales bars to the most expensive project and marks selected ones', () => {
    expect(projectRows([ALPHA, BETA], ['p2'])).toEqual([
      { id: 'p1', label: 'dev/alpha', path: '/home/dev/alpha', cost: '$40.00', tokens: '1.2M', sessions: 3, barPct: 100, selected: false },
      { id: 'p2', label: 'dev/beta', path: '/home/dev/beta', cost: '$10.00', tokens: '30k', sessions: 1, barPct: 25, selected: true },
    ]);
  });

  it('keeps the top eight', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ ...ALPHA, id: `p${index}`, cost: 12 - index }));
    expect(projectRows(many, [])).toHaveLength(8);
  });
});

describe('matchProjects', () => {
  const projects = [
    { id: 'p1', path: '/home/dev/Alpha', label: 'dev/Alpha' },
    { id: 'p2', path: '/srv/beta', label: 'srv/beta' },
  ];

  it('matches label or path case-insensitively', () => {
    expect(matchProjects(projects, 'ALPHA').map((project) => project.id)).toEqual(['p1']);
    expect(matchProjects(projects, '/srv').map((project) => project.id)).toEqual(['p2']);
    expect(matchProjects(projects, '  ')).toHaveLength(2);
  });
});

describe('sessionRows', () => {
  const titled: SessionSummary = {
    id: 'a1b2c3d4e5f6',
    title: 'Refactor parser',
    projectId: 'p1',
    projectLabel: 'dev/alpha',
    firstTs: '2026-03-05T10:00:00.000Z',
    lastTs: '2026-03-05T12:30:00.000Z',
    models: ['claude-opus-5', 'claude-sonnet-5'],
    tokensTotal: 1_500_000,
    cost: 20,
    subagentCost: 5,
  };
  const bare: SessionSummary = {
    id: 'ffff0000aaaa',
    title: null,
    projectId: null,
    projectLabel: null,
    firstTs: '2026-03-06T23:00:00.000Z',
    lastTs: '2026-03-07T01:00:00.000Z',
    models: ['claude-mystery-9'],
    tokensTotal: 900,
    cost: 5,
    subagentCost: 0,
  };

  it('formats rows with spans, model dots and bars', () => {
    expect(sessionRows([titled, bare], 'UTC')[0]).toEqual({
      index: 1,
      id: 'a1b2c3d4e5f6',
      shortId: 'a1b2c3d4',
      title: 'Refactor parser',
      untitled: false,
      project: 'dev/alpha',
      unknownProject: false,
      when: '03-05 10:00 → 12:30',
      whenTitle: '2026-03-05 10:00:00 → 2026-03-05 12:30:00 (UTC)',
      models: [
        { id: 'claude-opus-5', label: 'opus-5', color: '#FFB000' },
        { id: 'claude-sonnet-5', label: 'sonnet-5', color: '#8BD450' },
      ],
      tokens: '1.5M',
      cost: '$20.00',
      subShare: '25%',
      barPct: 100,
    });
  });

  it('formats the span and its hover text in the server zone', () => {
    expect(sessionRows([titled], 'Asia/Tokyo')[0]).toMatchObject({
      when: '03-05 19:00 → 21:30',
      whenTitle: '2026-03-05 19:00:00 → 2026-03-05 21:30:00 (Asia/Tokyo)',
    });
  });

  it('uses placeholders for a missing title or project', () => {
    expect(sessionRows([titled, bare], 'UTC')[1]).toMatchObject({
      index: 2,
      title: '(untitled)',
      untitled: true,
      project: '(unknown)',
      unknownProject: true,
      when: '03-06 23:00 → 03-07 01:00',
      tokens: '900',
      subShare: '—',
      barPct: 25,
    });
    expect(sessionRows([{ ...titled, title: '   ' }], 'UTC')[0]).toMatchObject({ title: '(untitled)', untitled: true });
  });
});
