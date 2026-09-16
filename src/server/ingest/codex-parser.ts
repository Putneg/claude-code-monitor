import type { CodexLimitSnapshot, CodexLimitWindowSnapshot } from '../db/codex-limits-repo.js';
import type { SessionTouch } from '../db/session-merge.js';
import {
  MAX_TURNS,
  rateLimitsSchema,
  sessionMetaSchema,
  stateSchema,
  tokenCountSchema,
  turnContextSchema,
  usageRecordSchema,
  type CodexTokenUsage,
  type CodexWindow,
} from './codex-schema.js';
import {
  inTimestampWindow,
  isRecord,
  normalizeCwd,
  type ParseContext,
  type SkipReason,
  type TokenCounts,
  type UsageRow,
} from './parser.js';

export { MAX_TURNS };
export type { CodexTokenUsage };

/** What a Codex rollout file has told the parser so far; stored between incremental reads. */
export interface CodexState {
  /** From session_meta, or from the first turn_context when session_meta had none. */
  readonly cwd: string | null;
  /** The model of the latest turn_context. */
  readonly model: string | null;
  /** [turn id, model] of the latest turns, oldest first. */
  readonly turns: readonly (readonly [string, string])[];
}

export const EMPTY_CODEX_STATE: CodexState = { cwd: null, model: null, turns: [] };

export type CodexStep =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | { readonly kind: 'usage'; readonly row: UsageRow; readonly touch: SessionTouch }
  | { readonly kind: 'limits'; readonly snapshot: CodexLimitSnapshot };

export interface CodexResult {
  readonly state: CodexState;
  readonly step: CodexStep;
}

const IGNORED: CodexStep = { kind: 'ignored' };
const INVALID: CodexStep = { kind: 'skipped', reason: 'invalid_record' };
const MARKERS = ['"session_meta"', '"turn_context"', '"token_usage_record"', '"token_count"'] as const;
const MS_PER_SECOND = 1_000;

export function isCodexCandidate(line: Buffer | string): boolean {
  return MARKERS.some((marker) => line.includes(marker));
}

/** Uncached input, cache reads and cache writes out of Codex's input_tokens, which counts all three. */
export function toCodexTokens(usage: CodexTokenUsage): TokenCounts {
  const cacheRead = Math.min(usage.cached_input_tokens ?? 0, usage.input_tokens);
  const cacheWrite = Math.min(usage.cache_write_input_tokens ?? 0, usage.input_tokens - cacheRead);
  return {
    input: usage.input_tokens - cacheRead - cacheWrite,
    output: usage.output_tokens,
    cacheRead,
    cacheWrite5m: cacheWrite,
    cacheWrite1h: 0,
  };
}

function onSessionMeta(state: CodexState, value: Record<string, unknown>): CodexResult {
  const parsed = sessionMetaSchema.safeParse(value);
  if (!parsed.success) return { state, step: INVALID };
  const cwd = normalizeCwd(parsed.data.payload.cwd);
  return { state: cwd === null ? state : { ...state, cwd }, step: IGNORED };
}

function rememberTurn(turns: CodexState['turns'], turnId: string, model: string): CodexState['turns'] {
  return [...turns.filter(([known]) => known !== turnId), [turnId, model] as const].slice(-MAX_TURNS);
}

function onTurnContext(state: CodexState, value: Record<string, unknown>): CodexResult {
  const parsed = turnContextSchema.safeParse(value);
  if (!parsed.success) return { state, step: INVALID };
  const { turn_id: turnId, model, cwd } = parsed.data.payload;
  const located = state.cwd === null ? { ...state, cwd: normalizeCwd(cwd) } : state;
  if (!model) return { state: located, step: IGNORED };
  const turns = turnId ? rememberTurn(located.turns, turnId, model) : located.turns;
  return { state: { ...located, model, turns }, step: IGNORED };
}

/** The model of the record's turn; a record whose turn_context the parser has not seen takes the latest model. */
function modelFor(state: CodexState, turnId: string | null | undefined): string | null {
  const turn = turnId ? state.turns.find(([known]) => known === turnId) : undefined;
  return turn?.[1] ?? state.model;
}

function onUsageRecord(state: CodexState, value: Record<string, unknown>, ctx: ParseContext): CodexStep {
  const parsed = usageRecordSchema.safeParse(value);
  if (!parsed.success) return INVALID;
  const { timestamp, payload } = parsed.data;
  const ts = Date.parse(timestamp);
  if (!inTimestampWindow(ts, ctx.now)) return { kind: 'skipped', reason: 'invalid_timestamp' };
  const model = modelFor(state, payload.turn_id);
  if (model === null) return { kind: 'skipped', reason: 'unknown_model' };
  // A subagent writes its own thread id and the session id of the thread that started it.
  const isSidechain = payload.thread_id !== payload.session_id;
  const row: UsageRow = {
    client: 'codex',
    messageId: payload.response_id,
    requestId: '',
    kind: 'primary',
    seq: 0,
    sessionId: payload.session_id,
    agentId: isSidechain ? payload.thread_id : null,
    isSidechain,
    model,
    speed: 'standard',
    ts,
    localDay: ctx.toLocalDay(ts),
    ...toCodexTokens(payload.usage),
    webSearchRequests: 0,
    webFetchRequests: 0,
  };
  return { kind: 'usage', row, touch: { sessionId: payload.session_id, cwd: state.cwd, isSidechain, ts } };
}

function toWindow(window: CodexWindow | null | undefined): CodexLimitWindowSnapshot | null {
  if (!window) return null;
  const resetsAt = window.resets_at ?? null;
  return {
    usedPercent: Math.min(100, Math.max(0, window.used_percent)),
    windowMinutes: window.window_minutes,
    resetsAt: resetsAt === null ? null : resetsAt * MS_PER_SECOND,
  };
}

function onTokenCount(value: Record<string, unknown>, ctx: ParseContext): CodexStep {
  const event = tokenCountSchema.safeParse(value);
  if (!event.success) return IGNORED;
  const observedAt = Date.parse(event.data.timestamp);
  const limits = rateLimitsSchema.safeParse(event.data.payload.rate_limits);
  if (!limits.success || !inTimestampWindow(observedAt, ctx.now)) return IGNORED;
  const primary = toWindow(limits.data.primary);
  const secondary = toWindow(limits.data.secondary);
  if (primary === null && secondary === null) return IGNORED;
  const credits = limits.data.credits;
  const snapshot: CodexLimitSnapshot = {
    limitId: limits.data.limit_id,
    planType: limits.data.plan_type ?? null,
    primary,
    secondary,
    credits: credits ? { hasCredits: credits.has_credits, unlimited: credits.unlimited, balance: credits.balance ?? null } : null,
    observedAt,
  };
  return { kind: 'limits', snapshot };
}

/**
 * Reads one rollout line. Usage comes only from token_usage_record lines, one per model response and keyed by its
 * response id. token_count lines are cumulative, re-emitted, and copied into forked and imported sessions, so only
 * their rate-limit readings are used.
 */
export function parseCodexLine(state: CodexState, line: string, ctx: ParseContext): CodexResult {
  if (!isCodexCandidate(line)) return { state, step: IGNORED };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { state, step: { kind: 'skipped', reason: 'invalid_json' } };
  }
  if (!isRecord(value)) return { state, step: IGNORED };
  switch (value.type) {
    case 'session_meta':
      return onSessionMeta(state, value);
    case 'turn_context':
      return onTurnContext(state, value);
    case 'token_usage_record':
      return { state, step: onUsageRecord(state, value, ctx) };
    case 'event_msg':
      return { state, step: onTokenCount(value, ctx) };
    default:
      return { state, step: IGNORED };
  }
}

export function serializeCodexState(state: CodexState): string {
  return JSON.stringify({ v: 1, cwd: state.cwd, model: state.model, turns: state.turns });
}

/** The stored state, or null when it is not JSON of the current shape. */
export function parseCodexState(text: string): CodexState | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = stateSchema.safeParse(value);
  return parsed.success ? { cwd: parsed.data.cwd, model: parsed.data.model, turns: parsed.data.turns } : null;
}
