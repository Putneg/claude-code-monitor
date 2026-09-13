import { z } from 'zod';
import { MAX_LIST_ITEM_LENGTH } from '../../shared/limits.js';

export type UsageKind = 'primary' | 'advisor' | 'fallback_attempt';

export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

export interface UsageRow extends TokenCounts {
  readonly messageId: string;
  readonly requestId: string;
  readonly kind: UsageKind;
  readonly seq: number;
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly isSidechain: boolean;
  readonly model: string;
  readonly speed: 'standard' | 'fast';
  readonly ts: number;
  readonly localDay: string;
  /** Server tool requests of this row: web search is billed per request, web fetch is stored without a fee. */
  readonly webSearchRequests: number;
  readonly webFetchRequests: number;
}

export type SkipReason = 'invalid_json' | 'invalid_record' | 'invalid_timestamp';

export type ParsedLine =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | { readonly kind: 'title'; readonly sessionId: string; readonly title: string }
  | {
      readonly kind: 'usage';
      readonly sessionId: string;
      readonly cwd: string | null;
      readonly isSidechain: boolean;
      readonly ts: number;
      readonly rows: readonly UsageRow[];
      /** usage.iterations[] entries that failed validation and were left out. */
      readonly droppedIterations: number;
      /** True for an advisor line whose top-level usage differs from the sum of its message iterations. */
      readonly advisorMismatch: boolean;
    };

export interface ParseContext {
  readonly toLocalDay: (tsMs: number) => string;
  /** Epoch ms used for the upper timestamp bound (now + 1 day). */
  readonly now: number;
}

/** Largest accepted token or request count: far above any context window, far below a SQLite integer overflow. */
export const MAX_TOKEN_COUNT = 1_000_000_000;
/** Earliest accepted timestamp; Claude Code transcripts do not predate 2023. */
export const MIN_TIMESTAMP_MS = Date.UTC(2023, 0, 1);
/** The latest accepted timestamp is the clock plus this much. */
export const FUTURE_SLACK_MS = 86_400_000;
/** Longest accepted id or model name: the API's list-item limit, so every stored id can be used as a filter. */
export const MAX_ID_LENGTH = MAX_LIST_ITEM_LENGTH;
/** Session titles are cut to this many code points. */
export const MAX_TITLE_CODE_POINTS = 500;
/** A longer cwd is treated as unknown. */
export const MAX_CWD_LENGTH = 4_096;
/** Longest accepted usage.iterations[] list: real lines carry a few, and every iteration can become a row. */
export const MAX_ITERATIONS = 100;

const USAGE_MARKER = '"usage":{';
const TITLE_MARKER = '"ai-title"';
const SYNTHETIC_MODEL = '<synthetic>';
const IGNORED: ParsedLine = { kind: 'ignored' };
/** The raw top-level counts the advisor check compares with the sum of the message iterations. */
const CHECKED_COUNTS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

const count = z.number().int().nonnegative().max(MAX_TOKEN_COUNT).nullish();
const id = z.string().min(1).max(MAX_ID_LENGTH);
const tokenShape = {
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count,
  cache_creation_input_tokens: count,
  cache_creation: z.object({ ephemeral_5m_input_tokens: count, ephemeral_1h_input_tokens: count }).nullish(),
};
const serverToolUse = z.object({ web_search_requests: count, web_fetch_requests: count }).nullish();
const iterationSchema = z.object({ type: z.string(), model: id.nullish(), ...tokenShape, server_tool_use: serverToolUse });
const usageSchema = z.object({
  ...tokenShape,
  server_tool_use: serverToolUse,
  speed: z.string().nullish(),
  // Validated entry by entry (parseIterations), so one malformed iteration does not cost the whole line; a list
  // longer than MAX_ITERATIONS does.
  iterations: z.array(z.unknown()).max(MAX_ITERATIONS).nullish(),
});
const assistantSchema = z.object({
  type: z.literal('assistant'),
  timestamp: z.string(),
  sessionId: id,
  // Not part of the usage key: a missing or empty request id is stored as ''.
  requestId: z.string().max(MAX_ID_LENGTH).nullish(),
  isSidechain: z.boolean().nullish(),
  agentId: id.nullish(),
  isApiErrorMessage: z.boolean().nullish(),
  cwd: z.string().nullish(),
  message: z.object({ id, model: id, usage: usageSchema }),
});
const titleSchema = z.object({
  type: z.literal('ai-title'),
  sessionId: id,
  aiTitle: z.string().min(1),
});

type Iteration = z.infer<typeof iterationSchema>;
type UsageValue = z.infer<typeof usageSchema>;
type RequestCounts = Pick<UsageRow, 'webSearchRequests' | 'webFetchRequests'>;
type RowBase = Omit<UsageRow, keyof TokenCounts | keyof RequestCounts | 'kind' | 'seq' | 'model'>;

/** A valid iteration and its position in usage.iterations[], which becomes the row's seq. */
interface IndexedIteration {
  readonly index: number;
  readonly iteration: Iteration;
}

interface Iterations {
  readonly valid: readonly IndexedIteration[];
  readonly dropped: number;
  /** A fallback_message entry is present, even an invalid one: the line's message iterations are failed attempts. */
  readonly hasFallback: boolean;
}

export function isCandidateLine(line: Buffer | string): boolean {
  return line.includes(USAGE_MARKER) || line.includes(TITLE_MARKER);
}

export function normalizeCwd(cwd: string | null | undefined): string | null {
  if (!cwd || cwd.length > MAX_CWD_LENGTH) return null;
  // Terminals report both c:\ and C:\ for the same directory; one spelling keeps one project.
  const normalized = cwd
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first `max` code points of `text`, never splitting a surrogate pair. */
function truncateCodePoints(text: string, max: number): string {
  // `max` code points span at most 2 * max UTF-16 units, so only that prefix is split into code points.
  return text.length <= max ? text : [...text.slice(0, 2 * max)].slice(0, max).join('');
}

function toTokenCounts(source: Omit<Iteration, 'type' | 'model'>): TokenCounts {
  const total = source.cache_creation_input_tokens ?? 0;
  const breakdown = source.cache_creation;
  const base = {
    input: source.input_tokens ?? 0,
    output: source.output_tokens ?? 0,
    cacheRead: source.cache_read_input_tokens ?? 0,
  };
  if (!breakdown) return { ...base, cacheWrite5m: total, cacheWrite1h: 0 };
  const write5m = breakdown.ephemeral_5m_input_tokens ?? 0;
  const write1h = breakdown.ephemeral_1h_input_tokens ?? 0;
  const remainder = Math.max(0, total - write5m - write1h);
  return { ...base, cacheWrite5m: write5m + remainder, cacheWrite1h: write1h };
}

/** Web search and fetch requests; a missing server_tool_use counts as none. */
function toRequestCounts(source: Pick<Iteration, 'server_tool_use'>): RequestCounts {
  return {
    webSearchRequests: source.server_tool_use?.web_search_requests ?? 0,
    webFetchRequests: source.server_tool_use?.web_fetch_requests ?? 0,
  };
}

function extraKind(type: string, hasFallback: boolean): UsageKind | null {
  if (type === 'advisor_message') return 'advisor';
  if (hasFallback && type === 'message') return 'fallback_attempt';
  return null;
}

function parseIterations(entries: readonly unknown[]): Iterations {
  const valid = entries.flatMap((entry, index): IndexedIteration[] => {
    const parsed = iterationSchema.safeParse(entry);
    return parsed.success ? [{ index, iteration: parsed.data }] : [];
  });
  const hasFallback = entries.some((entry) => isRecord(entry) && entry.type === 'fallback_message');
  return { valid, dropped: entries.length - valid.length, hasFallback };
}

/**
 * The advisor cost math relies on the top-level usage covering only the message iterations. Checked on lines with an
 * advisor iteration, no fallback and no dropped iteration (a dropped one would leave the message sum short).
 */
function advisorMismatch(usage: UsageValue, iterations: Iterations): boolean {
  const types = iterations.valid.map((item) => item.iteration.type);
  if (iterations.dropped > 0 || !types.includes('advisor_message') || types.includes('fallback_message')) return false;
  const messages = iterations.valid.filter((item) => item.iteration.type === 'message').map((item) => item.iteration);
  return CHECKED_COUNTS.some((field) => (usage[field] ?? 0) !== messages.reduce((sum, message) => sum + (message[field] ?? 0), 0));
}

function buildRows(
  base: RowBase,
  model: string,
  usage: UsageValue,
  iterations: readonly IndexedIteration[],
  hasFallback: boolean,
): UsageRow[] {
  const primary: UsageRow = { ...base, kind: 'primary', seq: 0, model, ...toTokenCounts(usage), ...toRequestCounts(usage) };
  const extra = iterations.flatMap(({ index, iteration }): UsageRow[] => {
    const kind = extraKind(iteration.type, hasFallback);
    if (kind === null) return [];
    const counts = { ...toTokenCounts(iteration), ...toRequestCounts(iteration) };
    return [{ ...base, kind, seq: index, model: iteration.model ?? model, ...counts }];
  });
  return [primary, ...extra];
}

function parseTitle(value: Record<string, unknown>): ParsedLine {
  const parsed = titleSchema.safeParse(value);
  if (!parsed.success) return { kind: 'skipped', reason: 'invalid_record' };
  return { kind: 'title', sessionId: parsed.data.sessionId, title: truncateCodePoints(parsed.data.aiTitle, MAX_TITLE_CODE_POINTS) };
}

const inTimestampWindow = (ts: number, now: number): boolean =>
  Number.isFinite(ts) && ts >= MIN_TIMESTAMP_MS && ts <= now + FUTURE_SLACK_MS;

function parseAssistant(value: Record<string, unknown>, ctx: ParseContext): ParsedLine {
  const message = value.message;
  if (!isRecord(message) || !isRecord(message.usage)) return IGNORED;
  const parsed = assistantSchema.safeParse(value);
  if (!parsed.success) return { kind: 'skipped', reason: 'invalid_record' };
  const record = parsed.data;
  if (record.message.model === SYNTHETIC_MODEL || record.isApiErrorMessage === true) return IGNORED;
  const ts = Date.parse(record.timestamp);
  if (!inTimestampWindow(ts, ctx.now)) return { kind: 'skipped', reason: 'invalid_timestamp' };
  const isSidechain = record.isSidechain === true;
  const usage = record.message.usage;
  const iterations = parseIterations(usage.iterations ?? []);
  const base: RowBase = {
    messageId: record.message.id,
    requestId: record.requestId ?? '',
    sessionId: record.sessionId,
    agentId: record.agentId ?? null,
    isSidechain,
    speed: usage.speed === 'fast' ? 'fast' : 'standard',
    ts,
    localDay: ctx.toLocalDay(ts),
  };
  return {
    kind: 'usage',
    sessionId: record.sessionId,
    cwd: normalizeCwd(record.cwd),
    isSidechain,
    ts,
    rows: buildRows(base, record.message.model, usage, iterations.valid, iterations.hasFallback),
    droppedIterations: iterations.dropped,
    advisorMismatch: advisorMismatch(usage, iterations),
  };
}

export function parseLine(line: string, ctx: ParseContext): ParsedLine {
  if (!isCandidateLine(line)) return IGNORED;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'skipped', reason: 'invalid_json' };
  }
  if (!isRecord(value)) return IGNORED;
  if (value.type === 'ai-title') return parseTitle(value);
  if (value.type !== 'assistant') return IGNORED;
  return parseAssistant(value, ctx);
}
