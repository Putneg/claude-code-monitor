import type { BackfillStatus, SourceStatus, SyncStatus } from '../shared/api.js';

export interface StatusSnapshot {
  readonly sync: SyncStatus;
  readonly backfill: BackfillStatus;
  readonly sources: readonly SourceStatus[];
}

export interface CycleStart {
  readonly backfill: boolean;
  readonly filesTotal: number;
  readonly bytesTotal: number;
}

export interface CycleOutcome {
  /** True when at least one transcript file was read and committed during the cycle. */
  readonly changed: boolean;
}

const INITIAL: StatusSnapshot = {
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
};

/** Holds an immutable snapshot that is replaced (never mutated) on every change. */
export class StatusTracker {
  readonly #now: () => number;
  #snapshot: StatusSnapshot = INITIAL;
  #cycleStartedAt: number | null = null;
  #lastProgressAt: number | null = null;
  #dataVersion = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  beginCycle(start: CycleStart): void {
    this.#lastProgressAt = this.#now();
    this.#cycleStartedAt = this.#now();
    this.#snapshot = {
      ...this.#snapshot,
      sync: { ...this.#snapshot.sync, state: 'scanning' },
      backfill: { active: start.backfill, filesDone: 0, filesTotal: start.filesTotal, bytesDone: 0, bytesTotal: start.bytesTotal },
    };
  }

  /** bytesDone is clamped to bytesTotal: a file can grow after the scan, and a failed file counts its planned bytes. */
  fileDone(bytes: number): void {
    this.#lastProgressAt = this.#now();
    this.#dataVersion += 1;
    const backfill = this.#snapshot.backfill;
    this.#snapshot = {
      ...this.#snapshot,
      backfill: {
        ...backfill,
        filesDone: backfill.filesDone + 1,
        bytesDone: Math.min(backfill.bytesDone + bytes, backfill.bytesTotal),
      },
    };
  }

  addSkipped(count: number): void {
    this.#addToSync('skippedLines', count);
  }

  addDroppedIterations(count: number): void {
    this.#addToSync('droppedIterations', count);
  }

  addUsageMismatches(count: number): void {
    this.#addToSync('usageMismatches', count);
  }

  #addToSync(field: 'skippedLines' | 'droppedIterations' | 'usageMismatches', count: number): void {
    if (count === 0) return;
    const sync = this.#snapshot.sync;
    this.#snapshot = { ...this.#snapshot, sync: { ...sync, [field]: sync[field] + count } };
  }

  setSources(sources: readonly SourceStatus[]): void {
    this.#snapshot = { ...this.#snapshot, sources: [...sources] };
  }

  endCycle(outcome: CycleOutcome): void {
    this.#lastProgressAt = this.#now();
    const now = this.#now();
    const startedAt = this.#cycleStartedAt ?? now;
    const endedAt = new Date(now).toISOString();
    const sync = this.#snapshot.sync;
    this.#cycleStartedAt = null;
    this.#snapshot = {
      ...this.#snapshot,
      sync: {
        ...sync,
        state: 'idle',
        lastSyncAt: endedAt,
        lastChangeAt: outcome.changed ? endedAt : sync.lastChangeAt,
        lastDurationMs: now - startedAt,
      },
      backfill: { ...this.#snapshot.backfill, active: false },
    };
  }

  snapshot(): StatusSnapshot {
    return this.#snapshot;
  }

  /** Time of the last cycle start, finished file or cycle end; null before the first cycle. */
  lastProgressAt(): number | null {
    return this.#lastProgressAt;
  }

  /** Increments on every finished file; part of the API response cache key. */
  dataVersion(): number {
    return this.#dataVersion;
  }
}
