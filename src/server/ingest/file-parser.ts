import type { Client } from '../../shared/models.js';
import type { CodexLimitSnapshot } from '../db/codex-limits-repo.js';
import type { SessionTouch } from '../db/session-merge.js';
import {
  EMPTY_CODEX_STATE,
  isCodexCandidate,
  parseCodexLine,
  parseCodexState,
  serializeCodexState,
  type CodexState,
} from './codex-parser.js';
import { isCandidateLine, parseLine, type ParseContext, type UsageRow } from './parser.js';

export interface TitleUpdate {
  readonly sessionId: string;
  readonly title: string;
}

/** What one read of a transcript file produced; each list is in file order. */
export interface ParsedFile {
  readonly rows: readonly UsageRow[];
  readonly touches: readonly SessionTouch[];
  readonly titles: readonly TitleUpdate[];
  readonly limits: readonly CodexLimitSnapshot[];
  /** Unusable lines; the ingestor adds lines over the reader's size cap. */
  readonly skipped: number;
  readonly droppedIterations: number;
  readonly usageMismatches: number;
}

/** Parses the complete lines of one read of one file. */
export interface FileParser {
  /** A cheap check on the raw bytes; only accepted lines are decoded and pushed. */
  accepts(line: Buffer): boolean;
  push(line: string): void;
  finish(): ParsedFile;
  /** What to store in file_state.parser_state after this read; null for a parser without state. */
  state(): string | null;
}

function createClaudeParser(ctx: ParseContext): FileParser {
  const rows: UsageRow[] = [];
  const touches: SessionTouch[] = [];
  const titles: TitleUpdate[] = [];
  let skipped = 0;
  let droppedIterations = 0;
  let usageMismatches = 0;
  return {
    accepts: (line) => isCandidateLine(line),
    push: (line) => {
      const parsed = parseLine(line, ctx);
      if (parsed.kind === 'skipped') skipped += 1;
      if (parsed.kind === 'title') titles.push({ sessionId: parsed.sessionId, title: parsed.title });
      if (parsed.kind !== 'usage') return;
      rows.push(...parsed.rows);
      touches.push({ sessionId: parsed.sessionId, cwd: parsed.cwd, isSidechain: parsed.isSidechain, ts: parsed.ts });
      droppedIterations += parsed.droppedIterations;
      if (parsed.advisorMismatch) usageMismatches += 1;
    },
    finish: () => ({ rows, touches, titles, limits: [], skipped, droppedIterations, usageMismatches }),
    state: () => null,
  };
}

function createCodexParser(initial: CodexState, ctx: ParseContext): FileParser {
  const rows: UsageRow[] = [];
  const touches: SessionTouch[] = [];
  const limits: CodexLimitSnapshot[] = [];
  let state = initial;
  let skipped = 0;
  return {
    accepts: (line) => isCodexCandidate(line),
    push: (line) => {
      const result = parseCodexLine(state, line, ctx);
      state = result.state;
      const step = result.step;
      if (step.kind === 'skipped') skipped += 1;
      if (step.kind === 'limits') limits.push(step.snapshot);
      if (step.kind !== 'usage') return;
      rows.push(step.row);
      touches.push(step.touch);
    },
    finish: () => ({ rows, touches, titles: [], limits, skipped, droppedIterations: 0, usageMismatches: 0 }),
    state: () => serializeCodexState(state),
  };
}

/** A parser for a read that starts at the beginning of the file. */
export function createFileParser(client: Client, ctx: ParseContext): FileParser {
  return client === 'codex' ? createCodexParser(EMPTY_CODEX_STATE, ctx) : createClaudeParser(ctx);
}

/**
 * A parser for a read that resumes at a stored offset. Returns null when a Codex file has no usable stored state: the
 * model of a record comes from an earlier turn_context line, so the file must be read again from the start.
 */
export function resumeFileParser(client: Client, persisted: string | null, ctx: ParseContext): FileParser | null {
  if (client === 'claude') return createClaudeParser(ctx);
  const state = persisted === null ? null : parseCodexState(persisted);
  return state === null ? null : createCodexParser(state, ctx);
}
