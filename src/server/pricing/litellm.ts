import { z } from 'zod';
import type { PriceEntry, PriceTable } from './types.js';

/** USD per token: $1,000 per million tokens. A larger rate is treated as corrupt and its entry is skipped. */
export const MAX_RATE_PER_TOKEN = 1e-3;
/** A larger fast-mode multiplier is treated as corrupt and its entry is skipped. */
export const MAX_FAST_MULTIPLIER = 20;

const rate = z.number().nonnegative().max(MAX_RATE_PER_TOKEN);
const entrySchema = z.object({
  litellm_provider: z.string().optional(),
  mode: z.string().nullish(),
  input_cost_per_token: rate.optional(),
  output_cost_per_token: rate.optional(),
  cache_creation_input_token_cost: rate.nullish(),
  cache_creation_input_token_cost_above_1hr: rate.nullish(),
  cache_read_input_token_cost: rate.nullish(),
  provider_specific_entry: z.object({ fast: z.number().positive().max(MAX_FAST_MULTIPLIER).nullish() }).nullish(),
});

type LiteLlmEntry = z.infer<typeof entrySchema>;

export interface NormalizeResult {
  readonly prices: PriceTable;
  readonly tieredKeys: readonly string[];
}

/** OpenAI entries for embeddings, audio, images and moderation are dropped: Codex bills text models only. */
const OPENAI_TEXT_MODES: ReadonlySet<string> = new Set(['chat', 'responses']);
/** Long-context rates, e.g. input_cost_per_token_above_200k_tokens (Anthropic) or ..._above_272k_tokens (OpenAI). */
const TIERED_KEY = /_above_\d+k_tokens$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function anthropicEntry(entry: LiteLlmEntry, input: number, output: number): PriceEntry {
  return {
    input,
    output,
    cacheWrite5m: entry.cache_creation_input_token_cost ?? input * 1.25,
    cacheWrite1h: entry.cache_creation_input_token_cost_above_1hr ?? input * 2,
    cacheRead: entry.cache_read_input_token_cost ?? input * 0.1,
    fastMultiplier: entry.provider_specific_entry?.fast ?? 1,
  };
}

/**
 * OpenAI publishes one cache-write rate and no fast multiplier. A cache rate it does not publish means cached tokens are
 * billed like any other input token.
 */
function openAiEntry(entry: LiteLlmEntry, input: number, output: number): PriceEntry {
  const cacheWrite = entry.cache_creation_input_token_cost ?? input;
  return {
    input,
    output,
    cacheWrite5m: cacheWrite,
    cacheWrite1h: cacheWrite,
    cacheRead: entry.cache_read_input_token_cost ?? input,
    fastMultiplier: 1,
  };
}

function toPriceEntry(entry: LiteLlmEntry): PriceEntry | null {
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  if (input === undefined || output === undefined) return null;
  if (entry.litellm_provider === 'anthropic') return anthropicEntry(entry, input, output);
  const textModel = OPENAI_TEXT_MODES.has(entry.mode ?? '');
  return entry.litellm_provider === 'openai' && textModel ? openAiEntry(entry, input, output) : null;
}

function parseEntry(value: unknown): PriceEntry | null {
  const parsed = entrySchema.safeParse(value);
  return parsed.success ? toPriceEntry(parsed.data) : null;
}

const hasTieredPricing = (value: unknown): boolean => isRecord(value) && Object.keys(value).some((key) => TIERED_KEY.test(key));

export function normalizeLiteLlm(raw: unknown): NormalizeResult {
  if (!isRecord(raw)) throw new Error('LiteLLM pricing payload is not an object');
  const accepted = Object.entries(raw).flatMap(([key, value]) => {
    const entry = parseEntry(value);
    return entry ? [{ key, entry, tiered: hasTieredPricing(value) }] : [];
  });
  return {
    prices: Object.fromEntries(accepted.map(({ key, entry }) => [key, entry])),
    tieredKeys: accepted.filter(({ tiered }) => tiered).map(({ key }) => key),
  };
}
