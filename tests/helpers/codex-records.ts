/** Synthetic Codex rollout lines, shaped like the files Codex writes under ~/.codex/sessions. */

export const CODEX_TS = '2026-09-10T12:00:00.000Z';
export const CODEX_CWD = '/home/dev/gamma';

export interface SessionMetaInput {
  readonly id: string;
  /** Defaults to `id`; null leaves the field out, as older builds do. */
  readonly sessionId?: string | null;
  /** Defaults to CODEX_CWD; null leaves the field out. */
  readonly cwd?: string | null;
  readonly timestamp?: string;
  /** A guardian subagent: `source.subagent` and `parent_thread_id` are set. */
  readonly subagent?: boolean;
}

export function sessionMetaLine(input: SessionMetaInput): string {
  const timestamp = input.timestamp ?? CODEX_TS;
  const sessionId = input.sessionId === undefined ? input.id : input.sessionId;
  return JSON.stringify({
    timestamp,
    ordinal: 0,
    type: 'session_meta',
    payload: {
      id: input.id,
      ...(sessionId === null ? {} : { session_id: sessionId }),
      timestamp,
      ...(input.cwd === null ? {} : { cwd: input.cwd ?? CODEX_CWD }),
      originator: 'codex_cli',
      cli_version: '0.154.0',
      source: input.subagent === true ? { subagent: { other: 'guardian' } } : 'cli',
      ...(input.subagent === true ? { parent_thread_id: sessionId } : {}),
      model_provider: 'openai',
      base_instructions: { text: 'You are a coding agent.' },
    },
  });
}

export interface TurnContextInput {
  /** null leaves the field out. */
  readonly turnId?: string | null;
  /** Leaving it undefined leaves the field out. */
  readonly model?: string;
  readonly cwd?: string;
  readonly timestamp?: string;
}

export function turnContextLine(input: TurnContextInput): string {
  const turnId = input.turnId === undefined ? 'turn-1' : input.turnId;
  return JSON.stringify({
    timestamp: input.timestamp ?? CODEX_TS,
    ordinal: 1,
    type: 'turn_context',
    payload: {
      ...(turnId === null ? {} : { turn_id: turnId }),
      cwd: input.cwd ?? CODEX_CWD,
      ...(input.model === undefined ? {} : { model: input.model }),
      approval_policy: 'on-request',
      effort: 'low',
    },
  });
}

export interface UsageRecordInput {
  readonly responseId: string;
  readonly threadId: string;
  /** Defaults to threadId (a main thread). */
  readonly sessionId?: string;
  /** Defaults to 'turn-1'; null leaves the field out. */
  readonly turnId?: string | null;
  readonly timestamp?: string;
  readonly input?: number;
  readonly cached?: number;
  readonly cacheWrite?: number;
  readonly output?: number;
  readonly reasoning?: number;
}

export function usageRecordLine(input: UsageRecordInput): string {
  const inputTokens = input.input ?? 0;
  const outputTokens = input.output ?? 0;
  const usage = {
    input_tokens: inputTokens,
    cached_input_tokens: input.cached ?? 0,
    cache_write_input_tokens: input.cacheWrite ?? 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: input.reasoning ?? 0,
    total_tokens: inputTokens + outputTokens,
  };
  const turnId = input.turnId === undefined ? 'turn-1' : input.turnId;
  return JSON.stringify({
    timestamp: input.timestamp ?? CODEX_TS,
    ordinal: 5,
    type: 'token_usage_record',
    payload: {
      thread_id: input.threadId,
      ...(turnId === null ? {} : { turn_id: turnId, root_turn_id: turnId }),
      session_id: input.sessionId ?? input.threadId,
      response_id: input.responseId,
      usage,
      turn_token_usage: usage,
      thread_token_usage: usage,
    },
  });
}

export interface WindowInput {
  readonly usedPercent: number;
  readonly windowMinutes: number;
  /** Epoch seconds, as Codex writes them. */
  readonly resetsAt?: number | null;
}

export interface CreditsInput {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  readonly balance: string | null;
}

export interface RateLimitsInput {
  readonly limitId?: string;
  readonly planType?: string | null;
  readonly primary?: WindowInput | null;
  readonly secondary?: WindowInput | null;
  /** Defaults to no credits with a "0" balance. */
  readonly credits?: CreditsInput | null;
}

const windowJson = (window: WindowInput | null | undefined) =>
  window === null || window === undefined
    ? null
    : { used_percent: window.usedPercent, window_minutes: window.windowMinutes, resets_at: window.resetsAt ?? null };

const creditsJson = (credits: CreditsInput | null | undefined) => {
  if (credits === null) return null;
  const value = credits ?? { hasCredits: false, unlimited: false, balance: '0' };
  return { has_credits: value.hasCredits, unlimited: value.unlimited, balance: value.balance };
};

function rateLimitsJson(limits: RateLimitsInput) {
  return {
    limit_id: limits.limitId ?? 'codex',
    limit_name: null,
    primary: windowJson(limits.primary),
    secondary: windowJson(limits.secondary),
    credits: creditsJson(limits.credits),
    individual_limit: null,
    spend_control_reached: null,
    plan_type: limits.planType === undefined ? 'plus' : limits.planType,
    rate_limit_reached_type: null,
  };
}

export interface TokenCountInput {
  readonly timestamp?: string;
  /** A cumulative total with an empty breakdown, as imported sessions carry; null writes `info: null`. */
  readonly totalTokens?: number | null;
  readonly rateLimits?: RateLimitsInput | null;
}

export function tokenCountLine(input: TokenCountInput): string {
  const total = input.totalTokens ?? null;
  const empty = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  const info =
    total === null
      ? null
      : {
          total_token_usage: { ...empty, total_tokens: total },
          last_token_usage: { ...empty, total_tokens: total },
          model_context_window: 258_400,
        };
  const limits = input.rateLimits ?? null;
  return JSON.stringify({
    timestamp: input.timestamp ?? CODEX_TS,
    ordinal: 6,
    type: 'event_msg',
    payload: { type: 'token_count', info, rate_limits: limits === null ? null : rateLimitsJson(limits) },
  });
}

/** An assistant message whose text is free to mention record markers. */
export function responseMessageLine(text: string, timestamp = CODEX_TS): string {
  return JSON.stringify({
    timestamp,
    ordinal: 7,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });
}
