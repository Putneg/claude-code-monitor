import { z } from 'zod';
import { MAX_CWD_LENGTH, MAX_ID_LENGTH, MAX_TOKEN_COUNT } from './parser.js';

/** Turns a Codex parser state remembers; a turn's usage records follow its turn_context closely. */
export const MAX_TURNS = 64;
/** Longest accepted rate-limit window: one year, in minutes. */
export const MAX_WINDOW_MINUTES = 525_600;
/** Latest accepted reset time, in epoch seconds (2100-01-01T00:00:00Z); every accepted value converts to an ISO string. */
export const MAX_RESETS_AT_SECONDS = 4_102_444_800;

const id = z.string().min(1).max(MAX_ID_LENGTH);
const count = z.number().int().nonnegative().max(MAX_TOKEN_COUNT);

/** Codex token usage: input_tokens includes cached and cache-write tokens, output_tokens includes reasoning tokens. */
export const tokenUsageSchema = z.object({
  input_tokens: count,
  cached_input_tokens: count.nullish(),
  cache_write_input_tokens: count.nullish(),
  output_tokens: count,
});
export type CodexTokenUsage = z.infer<typeof tokenUsageSchema>;

export const sessionMetaSchema = z.object({
  payload: z.object({ id, cwd: z.string().nullish() }),
});

export const turnContextSchema = z.object({
  payload: z.object({ turn_id: id.nullish(), model: id.nullish(), cwd: z.string().nullish() }),
});

export const usageRecordSchema = z.object({
  timestamp: z.string(),
  payload: z.object({
    thread_id: id,
    session_id: id,
    turn_id: id.nullish(),
    response_id: id,
    usage: tokenUsageSchema,
  }),
});

/** A token_count event; its rate_limits are validated separately so a bad reading costs only itself. */
export const tokenCountSchema = z.object({
  timestamp: z.string(),
  payload: z.object({ type: z.literal('token_count'), rate_limits: z.unknown() }),
});

const windowSchema = z.object({
  used_percent: z.number(),
  window_minutes: z.number().int().min(1).max(MAX_WINDOW_MINUTES),
  resets_at: z.number().int().nonnegative().max(MAX_RESETS_AT_SECONDS).nullish(),
});
export type CodexWindow = z.infer<typeof windowSchema>;

export const rateLimitsSchema = z.object({
  limit_id: id,
  plan_type: id.nullish(),
  primary: windowSchema.nullish(),
  secondary: windowSchema.nullish(),
  credits: z.object({ has_credits: z.boolean(), unlimited: z.boolean(), balance: z.string().max(MAX_ID_LENGTH).nullish() }).nullish(),
});

/** The persisted parser state (file_state.parser_state). */
export const stateSchema = z.object({
  v: z.literal(1),
  cwd: z.string().max(MAX_CWD_LENGTH).nullable(),
  model: id.nullable(),
  turns: z.array(z.tuple([id, id])).max(MAX_TURNS),
});
