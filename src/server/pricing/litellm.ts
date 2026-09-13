import { z } from 'zod';
import type { PriceEntry, PriceTable } from './types.js';

/** USD per token: $1,000 per million tokens. A larger rate is treated as corrupt and its entry is skipped. */
export const MAX_RATE_PER_TOKEN = 1e-3;
/** A larger fast-mode multiplier is treated as corrupt and its entry is skipped. */
export const MAX_FAST_MULTIPLIER = 20;

const rate = z.number().nonnegative().max(MAX_RATE_PER_TOKEN);
const entrySchema = z.object({
  litellm_provider: z.string().optional(),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPriceEntry(entry: LiteLlmEntry): PriceEntry | null {
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  if (input === undefined || output === undefined) return null;
  return {
    input,
    output,
    cacheWrite5m: entry.cache_creation_input_token_cost ?? input * 1.25,
    cacheWrite1h: entry.cache_creation_input_token_cost_above_1hr ?? input * 2,
    cacheRead: entry.cache_read_input_token_cost ?? input * 0.1,
    fastMultiplier: entry.provider_specific_entry?.fast ?? 1,
  };
}

function parseAnthropicEntry(value: unknown): PriceEntry | null {
  const parsed = entrySchema.safeParse(value);
  if (!parsed.success || parsed.data.litellm_provider !== 'anthropic') return null;
  return toPriceEntry(parsed.data);
}

const hasTieredPricing = (value: unknown): boolean =>
  isRecord(value) && Object.keys(value).some((key) => key.endsWith('_above_200k_tokens'));

export function normalizeLiteLlm(raw: unknown): NormalizeResult {
  if (!isRecord(raw)) throw new Error('LiteLLM pricing payload is not an object');
  const accepted = Object.entries(raw).flatMap(([key, value]) => {
    const entry = parseAnthropicEntry(value);
    return entry ? [{ key, entry, tiered: hasTieredPricing(value) }] : [];
  });
  return {
    prices: Object.fromEntries(accepted.map(({ key, entry }) => [key, entry])),
    tieredKeys: accepted.filter(({ tiered }) => tiered).map(({ key }) => key),
  };
}
