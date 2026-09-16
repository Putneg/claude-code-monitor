import { describe, expect, it } from 'vitest';
import { emptyStateKind, pendingIndicator, progressBar, statusView, visibleSources } from '../../../src/web/lib/status-view.js';
import { makeOverview, makeStatus } from './fixtures.js';

const live = makeStatus({
  tz: 'Europe/Kyiv',
  sync: { ...makeStatus().sync, lastSyncAt: '2026-09-11T11:02:11.000Z' },
  sources: [
    {
      path: '/claude/projects',
      ok: true,
      files: 754,
      bytes: 3.2 * 1024 ** 3,
      error: null,
      client: 'claude',
      required: true,
      present: true,
    },
  ],
  pricing: { source: 'litellm', fetchedAt: '2026-09-11T03:00:00.000Z', unpricedModels: [] },
});

describe('statusView', () => {
  it('summarizes sources, prices, zone and sync time', () => {
    expect(statusView(live, false)).toEqual({
      sources: '/claude/projects',
      files: '754 files · 3.2G',
      prices: 'prices: litellm · 09-11 06:00',
      tz: 'tz Europe/Kyiv',
      sync: 'sync 14:02:11',
      indicator: { kind: 'live', text: '● live', progress: null },
      warnings: [],
    });
  });

  it('shows backfill progress instead of live, apart from the state word', () => {
    const backfill = { active: true, filesDone: 312, filesTotal: 754, bytesDone: 1, bytesTotal: 2 };
    expect(statusView({ ...live, backfill }, false).indicator).toEqual({
      kind: 'backfill',
      text: 'backfill',
      progress: { files: '312/754', bar: '▓▓░░░' },
    });
  });

  it('warns about missing sources and unpriced models', () => {
    const broken = {
      ...live,
      sources: [
        {
          path: '/claude/projects',
          ok: false,
          files: 0,
          bytes: 0,
          error: 'ENOENT',
          client: 'claude' as const,
          required: true,
          present: false,
        },
      ],
      pricing: { ...live.pricing, unpricedModels: ['claude-x'] },
    };
    expect(statusView(broken, false).warnings).toEqual(['⚠ source missing', '⚠ 1 model unpriced']);
    const twoUnpriced = { ...live, pricing: { ...live.pricing, unpricedModels: ['a', 'b'] } };
    expect(statusView(twoUnpriced, false).warnings).toEqual(['⚠ 2 models unpriced']);
  });

  it('marks the API offline', () => {
    expect(statusView(live, true).indicator).toEqual({ kind: 'offline', text: '○ offline', progress: null });
  });

  it('warns about skipped lines, dropped iterations and advisor usage mismatches', () => {
    const noisy = { ...live, sync: { ...live.sync, skippedLines: 3, droppedIterations: 1, usageMismatches: 2 } };
    expect(statusView(noisy, false).warnings).toEqual(['⚠ 3 lines skipped', '⚠ 1 iteration dropped', '⚠ advisor usage check failed (2)']);
    const single = { ...live, sync: { ...live.sync, skippedLines: 1 } };
    expect(statusView(single, false).warnings).toEqual(['⚠ 1 line skipped']);
  });

  it('handles a status before the first sync', () => {
    const fresh = {
      ...live,
      sources: [],
      sync: { ...live.sync, lastSyncAt: null },
      pricing: { ...live.pricing, source: 'snapshot' as const, fetchedAt: null },
    };
    expect(statusView(fresh, false)).toMatchObject({
      sources: 'no sources',
      files: '0 files · 0B',
      prices: 'prices: snapshot',
      sync: 'sync pending',
    });
  });
});

describe('pendingIndicator', () => {
  it('says connecting before the first status, and offline once a poll has failed', () => {
    expect(pendingIndicator(false)).toEqual({ kind: 'connecting', text: 'connecting…', progress: null });
    expect(pendingIndicator(true)).toEqual({ kind: 'offline', text: '○ offline', progress: null });
  });
});

describe('progressBar', () => {
  it('fills cells in proportion', () => {
    expect(progressBar(0, 0)).toBe('░░░░░');
    expect(progressBar(5, 5)).toBe('▓▓▓▓▓');
    expect(progressBar(1, 4, 8)).toBe('▓▓░░░░░░');
  });
});

describe('emptyStateKind', () => {
  const noRows = { ...makeStatus().data, rows: 0 };

  it('explains an empty database', () => {
    expect(
      emptyStateKind(
        makeStatus({
          data: noRows,
          sources: [{ path: '/p', ok: false, files: 0, bytes: 0, error: 'ENOENT', client: 'claude', required: true, present: false }],
        }),
        null,
      ),
    ).toBe('source-missing');
    expect(emptyStateKind(makeStatus({ data: noRows, backfill: { ...makeStatus().backfill, active: true } }), null)).toBe('backfill');
    expect(emptyStateKind(makeStatus({ data: noRows, sync: { ...makeStatus().sync, lastSyncAt: null } }), null)).toBe('backfill');
    expect(emptyStateKind(makeStatus({ data: noRows }), null)).toBe('no-data');
  });

  it('reports a range without usage once data exists', () => {
    expect(emptyStateKind(makeStatus(), null)).toBeNull();
    expect(emptyStateKind(makeStatus(), makeOverview())).toBeNull();
    const emptyRange = makeOverview({ totals: { ...makeOverview().totals, tokensTotal: 0 } });
    expect(emptyStateKind(makeStatus(), emptyRange)).toBe('no-usage');
    expect(emptyStateKind(makeStatus({ backfill: { ...makeStatus().backfill, active: true } }), emptyRange)).toBe('backfill');
  });
});

describe('optional sources', () => {
  const claude = {
    path: '/claude/projects',
    ok: true,
    files: 3,
    bytes: 10,
    error: null,
    client: 'claude' as const,
    required: true,
    present: true,
  };
  const absent = {
    path: '/codex/archived_sessions',
    ok: false,
    files: 0,
    bytes: 0,
    error: 'not accessible: ENOENT',
    client: 'codex' as const,
    required: false,
    present: false,
  };
  const codex = {
    path: '/codex/sessions',
    ok: true,
    files: 2,
    bytes: 5,
    error: null,
    client: 'codex' as const,
    required: false,
    present: true,
  };
  const locked = { ...codex, ok: false, files: 0, bytes: 0, error: 'not accessible: EACCES' };

  it('lists required sources and optional ones that exist', () => {
    expect(visibleSources([claude, absent, codex])).toEqual([claude, codex]);
    expect(statusView({ ...live, sources: [claude, absent, codex] }, false).sources).toBe('/claude/projects, /codex/sessions');
  });

  it('does not warn about an absent optional source, and warns about a broken one', () => {
    expect(statusView({ ...live, sources: [claude, absent] }, false).warnings).toEqual([]);
    expect(statusView({ ...live, sources: [claude, locked] }, false).warnings).toEqual(['⚠ codex source unreadable']);
  });

  it('shows the source-missing state only for a required source', () => {
    const noRows = { ...makeStatus().data, rows: 0 };
    expect(emptyStateKind(makeStatus({ data: noRows, sources: [claude, absent] }), null)).toBe('no-data');
    expect(emptyStateKind(makeStatus({ data: noRows, sources: [{ ...claude, ok: false }, codex] }), null)).toBe('source-missing');
  });
});
