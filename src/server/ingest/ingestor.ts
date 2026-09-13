import type { SourceStatus } from '../../shared/api.js';
import type { Db } from '../db/connection.js';
import type { FileState } from '../db/file-state-repo.js';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../logger.js';
import type { StatusTracker } from '../status.js';
import { fingerprintCoversHead, fingerprintMatches, readFingerprint } from './fingerprint.js';
import { createNotices, type Notices } from './notices.js';
import { isCandidateLine, parseLine, type ParseContext, type ParsedLine } from './parser.js';
import { readCompleteLines } from './reader.js';
import { errorCode, planWork, scanSources, type SourceScan, type WorkItem } from './scanner.js';

export const BACKFILL_BYTES_THRESHOLD = 32 * 1024 * 1024;

export interface IngestDeps {
  readonly db: Db;
  readonly repos: Pick<Repos, 'usage' | 'sessions' | 'files'>;
  readonly roots: readonly string[];
  readonly toLocalDay: (tsMs: number) => string;
  readonly status: StatusTracker;
  readonly logger: Logger;
  readonly scan?: (roots: readonly string[]) => Promise<SourceScan[]>;
  readonly shouldStop?: () => boolean;
  /** Clock for the timestamp window; defaults to Date.now. */
  readonly now?: () => number;
  /** Problems already logged, kept across cycles; a fresh Notices per cycle when absent. */
  readonly notices?: Notices;
  /** Called after a file's rows are committed, with the models in that file. */
  readonly onFileCommitted?: (models: ReadonlySet<string>) => void;
  /** Longest transcript line that is parsed; longer lines are counted as skipped. Defaults to the reader's MAX_LINE_BYTES. */
  readonly maxLineBytes?: number;
}

export interface FileResult {
  readonly rows: number;
  /** Unusable lines, including lines over the reader's size cap. */
  readonly skipped: number;
  readonly droppedIterations: number;
  readonly usageMismatches: number;
  readonly bytesRead: number;
  readonly models: ReadonlySet<string>;
}

export interface CycleResult {
  readonly files: number;
  readonly rows: number;
  readonly skipped: number;
  readonly droppedIterations: number;
  readonly usageMismatches: number;
  readonly models: ReadonlySet<string>;
  readonly backfill: boolean;
}

type RelevantLine = Exclude<ParsedLine, { kind: 'ignored' }>;
type UsageLine = Extract<ParsedLine, { kind: 'usage' }>;

function applyFile(deps: IngestDeps, lines: readonly RelevantLine[], state: FileState): void {
  const { usage, sessions, files } = deps.repos;
  deps.db.transaction(() => {
    for (const line of lines) {
      if (line.kind === 'usage') {
        line.rows.forEach((row) => usage.upsert(row));
        sessions.touch({ sessionId: line.sessionId, cwd: line.cwd, isSidechain: line.isSidechain, ts: line.ts });
      } else if (line.kind === 'title') {
        sessions.setTitle(line.sessionId, line.title);
      }
    }
    files.upsert(state);
  })();
}

/** Where to read from: the planned offset, or 0 when the file's first bytes no longer match its stored fingerprint. */
async function readStart(deps: IngestDeps, item: WorkItem): Promise<number> {
  if (item.startOffset === 0 || item.fingerprint === null) return item.startOffset;
  if (await fingerprintMatches(item.file.path, item.fingerprint)) return item.startOffset;
  deps.logger.debug({ file: item.file.path }, 'transcript file head changed');
  deps.logger.info({ offset: item.startOffset }, 'transcript file was replaced; reading it again from the start');
  return 0;
}

/**
 * The stored fingerprint of a resumed file whose head it covers in full; otherwise a fresh one, which also widens a
 * fingerprint taken while the file was shorter than its head.
 */
async function headFingerprint(item: WorkItem, start: number, size: number): Promise<string> {
  const stored = item.fingerprint;
  if (start > 0 && stored !== null && fingerprintCoversHead(stored, size)) return stored;
  return readFingerprint(item.file.path, size);
}

export async function ingestFile(deps: IngestDeps, item: WorkItem): Promise<FileResult> {
  const path = item.file.path;
  const start = await readStart(deps, item);
  const lines: RelevantLine[] = [];
  const ctx: ParseContext = { toLocalDay: deps.toLocalDay, now: (deps.now ?? Date.now)() };
  const outcome = await readCompleteLines(
    path,
    start,
    (raw) => {
      if (!isCandidateLine(raw)) return;
      const parsed = parseLine(raw.toString('utf8'), ctx);
      if (parsed.kind !== 'ignored') lines.push(parsed);
    },
    deps.maxLineBytes,
  );
  const size = Math.max(item.file.size, outcome.newOffset);
  // Awaited before the commit: nothing async may run between applyFile and the caller's status.fileDone.
  const fingerprint = await headFingerprint(item, start, size);
  const state: FileState = { path, size, mtimeMs: item.file.mtimeMs, offset: outcome.newOffset, fingerprint };
  const usageLines = lines.filter((line): line is UsageLine => line.kind === 'usage');
  const usageRows = usageLines.flatMap((line) => line.rows);
  const models = new Set(usageRows.map((row) => row.model));
  applyFile(deps, lines, state);
  deps.onFileCommitted?.(models);
  const skipped = lines.filter((line) => line.kind === 'skipped').length + outcome.oversizedLines;
  if (skipped > 0) deps.logger.debug({ file: path, offset: start, skipped }, 'skipped invalid lines');
  return {
    rows: usageRows.length,
    skipped,
    droppedIterations: usageLines.reduce((sum, line) => sum + line.droppedIterations, 0),
    usageMismatches: usageLines.filter((line) => line.advisorMismatch).length,
    bytesRead: outcome.bytesRead,
    models,
  };
}

const toSourceStatus = (scan: SourceScan): SourceStatus => ({
  path: scan.root,
  ok: scan.ok,
  files: scan.files.length,
  bytes: scan.files.reduce((sum, file) => sum + file.size, 0),
  error: scan.error,
});

/** Source outages and unreadable entries are logged when they start, and a source's return once. */
function reportScans(logger: Logger, notices: Notices, scans: readonly SourceScan[]): void {
  for (const scan of scans) {
    const key = `source:${scan.root}`;
    if (!scan.ok && notices.firstTime(key)) logger.warn({ root: scan.root, error: scan.error }, 'transcript source unavailable');
    if (scan.ok && notices.clear(key)) logger.info({ root: scan.root }, 'transcript source available again');
    for (const path of scan.unreadable) {
      if (notices.firstTime(`unreadable:${path}`)) logger.warn({ path }, 'skipping an unreadable entry under a transcript source');
    }
  }
}

function reportFileFailure(logger: Logger, notices: Notices, item: WorkItem, error: unknown): void {
  const payload = { file: item.file.path, code: errorCode(error), err: error };
  if (notices.firstTime(`file:${item.file.path}`)) logger.warn(payload, 'failed to ingest file');
  else logger.debug(payload, 'failed to ingest file again');
}

async function processAll(deps: IngestDeps, work: readonly WorkItem[], notices: Notices): Promise<FileResult[]> {
  const results: FileResult[] = [];
  for (const item of work) {
    if (deps.shouldStop?.()) break;
    try {
      const result = await ingestFile(deps, item);
      deps.status.fileDone(result.bytesRead);
      results.push(result);
      deps.status.addSkipped(result.skipped);
      deps.status.addDroppedIterations(result.droppedIterations);
      deps.status.addUsageMismatches(result.usageMismatches);
      notices.clear(`file:${item.file.path}`);
    } catch (error) {
      reportFileFailure(deps.logger, notices, item, error);
      deps.status.fileDone(item.file.size - item.startOffset);
    }
  }
  return results;
}

function combine(results: readonly FileResult[], backfill: boolean): CycleResult {
  const total = (pick: (result: FileResult) => number): number => results.reduce((sum, result) => sum + pick(result), 0);
  return {
    files: results.length,
    rows: total((r) => r.rows),
    skipped: total((r) => r.skipped),
    droppedIterations: total((r) => r.droppedIterations),
    usageMismatches: total((r) => r.usageMismatches),
    models: new Set(results.flatMap((r) => [...r.models])),
    backfill,
  };
}

export async function runIngestCycle(deps: IngestDeps): Promise<CycleResult> {
  const notices = deps.notices ?? createNotices();
  const scans = await (deps.scan ?? scanSources)(deps.roots);
  deps.status.setSources(scans.map(toSourceStatus));
  reportScans(deps.logger, notices, scans);
  const known = deps.repos.files.all();
  const plan = planWork(scans, known);
  deps.repos.files.remove(plan.removed);
  const backfill = known.size === 0 || plan.pendingBytes >= BACKFILL_BYTES_THRESHOLD;
  deps.status.beginCycle({ backfill, filesTotal: plan.work.length, bytesTotal: plan.pendingBytes });
  let results: readonly FileResult[] = [];
  try {
    results = await processAll(deps, plan.work, notices);
    const result = combine(results, backfill);
    if (result.usageMismatches > 0) {
      deps.logger.warn(
        { lines: result.usageMismatches },
        'advisor usage check failed: top-level usage differs from the message iterations',
      );
    }
    return result;
  } finally {
    deps.status.endCycle({ changed: results.length > 0 });
  }
}
