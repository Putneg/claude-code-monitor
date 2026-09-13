import { describe, expect, it } from 'vitest';
import { StatusTracker } from '../../src/server/status.js';

describe('StatusTracker', () => {
  it('increments the data version on every finished file and nothing else', () => {
    const tracker = new StatusTracker(() => 0);
    expect(tracker.dataVersion()).toBe(0);
    tracker.beginCycle({ backfill: false, filesTotal: 2, bytesTotal: 20 });
    tracker.addSkipped(1);
    tracker.fileDone(10);
    tracker.fileDone(10);
    tracker.endCycle({ changed: true });
    expect(tracker.dataVersion()).toBe(2);
  });

  it('records ingest progress at a cycle start, a finished file and a cycle end', () => {
    let now = 1_000;
    const tracker = new StatusTracker(() => now);
    expect(tracker.lastProgressAt()).toBeNull();
    tracker.beginCycle({ backfill: false, filesTotal: 1, bytesTotal: 10 });
    expect(tracker.lastProgressAt()).toBe(1_000);
    now = 2_000;
    tracker.fileDone(10);
    expect(tracker.lastProgressAt()).toBe(2_000);
    now = 3_000;
    tracker.endCycle({ changed: true });
    expect(tracker.lastProgressAt()).toBe(3_000);
  });

  it('does not count skipped lines or a source update as progress', () => {
    const tracker = new StatusTracker(() => 5_000);
    tracker.addSkipped(2);
    tracker.setSources([]);
    expect(tracker.lastProgressAt()).toBeNull();
  });

  it('starts idle with no sync yet', () => {
    const tracker = new StatusTracker(() => 0);
    expect(tracker.snapshot()).toEqual({
      sync: {
        state: 'idle',
        lastSyncAt: null,
        lastChangeAt: null,
        lastDurationMs: null,
        skippedLines: 0,
        droppedIterations: 0,
        usageMismatches: 0,
      },
      backfill: { active: false, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 },
      sources: [],
    });
  });

  it('tracks a cycle from start to end', () => {
    let now = Date.parse('2026-09-11T10:00:00Z');
    const tracker = new StatusTracker(() => now);
    tracker.beginCycle({ backfill: true, filesTotal: 2, bytesTotal: 300 });
    expect(tracker.snapshot().sync.state).toBe('scanning');
    tracker.fileDone(100);
    tracker.addSkipped(3);
    tracker.addDroppedIterations(2);
    tracker.addUsageMismatches(1);
    tracker.addDroppedIterations(0);
    expect(tracker.snapshot().backfill).toEqual({ active: true, filesDone: 1, filesTotal: 2, bytesDone: 100, bytesTotal: 300 });
    now += 1_500;
    tracker.endCycle({ changed: true });
    const snapshot = tracker.snapshot();
    expect(snapshot.sync).toEqual({
      state: 'idle',
      lastSyncAt: '2026-09-11T10:00:01.500Z',
      lastChangeAt: '2026-09-11T10:00:01.500Z',
      lastDurationMs: 1_500,
      skippedLines: 3,
      droppedIterations: 2,
      usageMismatches: 1,
    });
    expect(snapshot.backfill.active).toBe(false);
    expect(snapshot.backfill.filesDone).toBe(1);
  });

  it('never reports more bytes done than the cycle planned', () => {
    const tracker = new StatusTracker(() => 0);
    tracker.beginCycle({ backfill: true, filesTotal: 2, bytesTotal: 100 });
    tracker.fileDone(80);
    tracker.fileDone(80);
    expect(tracker.snapshot().backfill).toEqual({ active: true, filesDone: 2, filesTotal: 2, bytesDone: 100, bytesTotal: 100 });
  });

  it('moves lastChangeAt only when a cycle read files', () => {
    let now = Date.parse('2026-09-11T10:00:00Z');
    const tracker = new StatusTracker(() => now);
    tracker.beginCycle({ backfill: false, filesTotal: 1, bytesTotal: 10 });
    tracker.endCycle({ changed: true });
    now += 60_000;
    tracker.beginCycle({ backfill: false, filesTotal: 0, bytesTotal: 0 });
    tracker.endCycle({ changed: false });
    expect(tracker.snapshot().sync).toMatchObject({
      lastSyncAt: '2026-09-11T10:01:00.000Z',
      lastChangeAt: '2026-09-11T10:00:00.000Z',
    });
  });

  it('replaces the source list and never mutates earlier snapshots', () => {
    const tracker = new StatusTracker(() => 0);
    const before = tracker.snapshot();
    tracker.setSources([{ path: '/p', ok: true, files: 3, bytes: 10, error: null }]);
    expect(tracker.snapshot().sources).toHaveLength(1);
    expect(before.sources).toEqual([]);
  });
});
