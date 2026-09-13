import { describe, expect, it } from 'vitest';
import { normalizeLiteLlm } from '../../src/server/pricing/litellm.js';

const payload = {
  sample_spec: { litellm_provider: 'sample', input_cost_per_token: 0 },
  'claude-opus-5': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
    cache_read_input_token_cost: 5e-7,
    provider_specific_entry: { us: 1.1, fast: 2 },
  },
  'claude-minimal': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
  },
  'claude-tiered': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    input_cost_per_token_above_200k_tokens: 6e-6,
  },
  'claude-no-output': { litellm_provider: 'anthropic', input_cost_per_token: 1e-6 },
  'bedrock/claude-opus-5': {
    litellm_provider: 'bedrock',
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
  },
  'broken-entry': 'not an object',
};

describe('normalizeLiteLlm', () => {
  const result = normalizeLiteLlm(payload);

  it('keeps only complete anthropic entries', () => {
    expect(Object.keys(result.prices).sort()).toEqual(['claude-minimal', 'claude-opus-5', 'claude-tiered']);
  });

  it('copies explicit rates and the fast multiplier', () => {
    expect(result.prices['claude-opus-5']).toEqual({
      input: 5e-6,
      output: 2.5e-5,
      cacheWrite5m: 6.25e-6,
      cacheWrite1h: 1e-5,
      cacheRead: 5e-7,
      fastMultiplier: 2,
    });
  });

  it('fills missing cache rates with ccusage defaults', () => {
    const entry = result.prices['claude-minimal'];
    expect(entry?.cacheWrite5m).toBeCloseTo(1.25e-6, 15);
    expect(entry?.cacheWrite1h).toBeCloseTo(2e-6, 15);
    expect(entry?.cacheRead).toBeCloseTo(1e-7, 15);
    expect(entry?.fastMultiplier).toBe(1);
  });

  it('reports entries with tiered pricing', () => {
    expect(result.tieredKeys).toEqual(['claude-tiered']);
  });

  it('rejects a non-object payload', () => {
    expect(() => normalizeLiteLlm(['nope'])).toThrow('LiteLLM pricing payload is not an object');
  });
});

describe('normalizeLiteLlm rate bounds', () => {
  const entry = (overrides: Record<string, unknown>) => ({
    litellm_provider: 'anthropic',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    ...overrides,
  });

  it('accepts rates up to $1,000 per million tokens and a fast multiplier up to 20', () => {
    const { prices } = normalizeLiteLlm({
      'claude-edge': entry({
        input_cost_per_token: 1e-3,
        output_cost_per_token: 1e-3,
        cache_creation_input_token_cost: 1e-3,
        cache_creation_input_token_cost_above_1hr: 1e-3,
        cache_read_input_token_cost: 1e-3,
        provider_specific_entry: { fast: 20 },
      }),
    });
    expect(prices['claude-edge']).toEqual({
      input: 1e-3,
      output: 1e-3,
      cacheWrite5m: 1e-3,
      cacheWrite1h: 1e-3,
      cacheRead: 1e-3,
      fastMultiplier: 20,
    });
  });

  it.each([
    ['input_cost_per_token', { input_cost_per_token: 1.1e-3 }],
    ['output_cost_per_token', { output_cost_per_token: 2e-3 }],
    ['cache_creation_input_token_cost', { cache_creation_input_token_cost: 1 }],
    ['cache_creation_input_token_cost_above_1hr', { cache_creation_input_token_cost_above_1hr: 5e-3 }],
    ['cache_read_input_token_cost', { cache_read_input_token_cost: 1.5e-3 }],
    ['provider_specific_entry.fast', { provider_specific_entry: { fast: 21 } }],
  ])('skips an entry whose %s is out of bounds', (_field, overrides) => {
    const { prices } = normalizeLiteLlm({ 'claude-bad': entry(overrides), 'claude-good': entry({}) });
    expect(Object.keys(prices)).toEqual(['claude-good']);
  });
});
