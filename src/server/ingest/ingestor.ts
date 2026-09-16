import type { SourceStatus } from '../../shared/api.js';
import type { Db } from '../db/connection.js';
import type { FileState } from '../db/file-state-repo.js';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../logger.js';
import type { StatusTracker } from '../status.js';
import { createFileParser, resumeFileParser, type FileParser, type ParsedFile } from './file-parser.js';
import { fingerprintCoversHead, fingerprintMatches, readFingerprint } from './fingerprint.js';
import { createNotices, type Notices } from './notices.js';
import type { ParseContext } from './parser.js';
import { readCompleteLines } from './reader.js';
import { errorCode, planWork, scanSources, type RootScan, type WorkItem } from './scanner.js';
import type { SourceRoot } from './sources.js';

export const BACKFILL_BYTES_THRESHOLD = 32 * 1024 * 1024;

export interface IngestDeps {
  readonly db: Db;
  readonly repos: Pick<Repos, 'usage' | 'sessions' | 'files' | 'codexLimits'>;
  readonly roots: readonly SourceRoot[];
  readonly toLocalDay: (tsMs: number) => string;
  readonly status: StatusTracker;
  readonly logger: Logger;
  readonly scan?: (roots: readonly SourceRoot[]) => Promise<RootScan[]>;
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

/** One transaction per file; rows and session fields are independent, so each list is written in turn. */
function applyFile(deps: IngestDeps, parsed: ParsedFile, state: FileState): void {
  const { usage, sessions, files, codexLimits } = deps.repos;
  deps.db.transaction(() => {
    parsed.rows.forEach((row) => usage.upsert(row));
    parsed.touches.forEach((touch) => sessions.touch(touch));
    parsed.titles.forEach((title) => sessions.setTitle(title.sessionId, title.title));
    parsed.limits.forEach((snapshot) => codexLimits.upsert(snapshot));
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

interface ReadPlan {
  readonly start: number;
  readonly parser: FileParser;
}

/** The offset to read from and its parser; a resumed read whose parser cannot resume starts over at 0. */
async function planRead(deps: IngestDeps, item: WorkItem, ctx: ParseContext): Promise<ReadPlan> {
  const start = await readStart(deps, item);
  if (start === 0) return { start, parser: createFileParser(item.client, ctx) };
  const parser = resumeFileParser(item.client, item.parserState, ctx);
  if (parser !== null) return { start, parser };
  deps.logger.debug({ file: item.file.path }, 'transcript parser state unusable');
  deps.logger.info({ offset: start }, 'transcript parser state is missing or invalid; reading the file again from the start');
  return { start: 0, parser: createFileParser(item.client, ctx) };
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
  const ctx: ParseContext = { toLocalDay: deps.toLocalDay, now: (deps.now ?? Date.now)() };
  const { start, parser } = await planRead(deps, item, ctx);
  const outcome = await readCompleteLines(
    path,
    start,
    (raw) => {
      if (parser.accepts(raw)) parser.push(raw.toString('utf8'));
    },
    deps.maxLineBytes,
  );
  const size = Math.max(item.file.size, outcome.newOffset);
  // Awaited before the commit: nothing async may run between applyFile and the caller's status.fileDone.
  const fingerprint = await headFingerprint(item, start, size);
  const parsed = parser.finish();
  const state: FileState = { path, size, mtimeMs: item.file.mtimeMs, offset: outcome.newOffset, fingerprint, parserState: parser.state() };
  const models = new Set(parsed.rows.map((row) => row.model));
  applyFile(deps, parsed, state);
  deps.onFileCommitted?.(models);
  const skipped = parsed.skipped + outcome.oversizedLines;
  if (skipped > 0) deps.logger.debug({ file: path, offset: start, skipped }, 'skipped invalid lines');
  return {
    rows: parsed.rows.length,
    skipped,
    droppedIterations: parsed.droppedIterations,
    usageMismatches: parsed.usageMismatches,
    bytesRead: outcome.bytesRead,
    models,
  };
}

const toSourceStatus = (scan: RootScan): SourceStatus => ({
  path: scan.root,
  ok: scan.ok,
  files: scan.files.length,
  bytes: scan.files.reduce((sum, file) => sum + file.size, 0),
  error: scan.error,
  client: scan.client,
  required: scan.required,
  present: scan.absence === undefined,
});

/** An optional root (a Codex folder) that is missing or empty is simply not in use. */
const isQuietlyAbsent = (scan: RootScan): boolean => !scan.required && scan.absence !== undefined;

/** Source outages and unreadable entries are logged when they start, and a source's return once. */
function reportScans(logger: Logger, notices: Notices, scans: readonly RootScan[]): void {
  for (const scan of scans) {
    const key = `source:${scan.root}`;
    const failing = !scan.ok && !isQuietlyAbsent(scan);
    if (failing && notices.firstTime(key)) logger.warn({ root: scan.root, error: scan.error }, 'transcript source unavailable');
    if (!failing && notices.clear(key)) logger.info({ root: scan.root }, 'transcript source available again');
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
