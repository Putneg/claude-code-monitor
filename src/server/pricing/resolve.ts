const normalize = (value: string): string => value.toLowerCase().replace(/[.@]/g, '-');
const isAlphanumeric = (char: string | undefined): boolean => char !== undefined && /[a-z0-9]/i.test(char);

/**
 * A needle ending with a digit must not be followed by "-N" unless N is an
 * 8-digit date: "claude-opus-4" must not match "claude-opus-4-1-20250805".
 */
function violatesVersionGuard(needle: string, rest: string): boolean {
  if (!/\d$/.test(needle)) return false;
  const next = /^-(\d+)/.exec(rest);
  return next !== null && next[1]?.length !== 8;
}

function containsAtBoundary(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const rest = haystack.slice(index + needle.length);
    const boundedBefore = !isAlphanumeric(haystack[index - 1]);
    const boundedAfter = !isAlphanumeric(rest[0]);
    if (boundedBefore && boundedAfter && !violatesVersionGuard(needle, rest)) return true;
    from = index + 1;
  }
}

function fuzzyMatches(model: string, key: string): boolean {
  return containsAtBoundary(model, key) || containsAtBoundary(key, model);
}

/** LiteLLM also lists some models under a provider prefix. */
const PROVIDER_PREFIXES = ['anthropic/', 'openai/'] as const;

/** Port of ccusage's model matching (MIT). Returns the LiteLLM key or null. */
export function resolvePriceKey(model: string, keys: readonly string[]): string | null {
  if (keys.includes(model)) return model;
  const prefixed = PROVIDER_PREFIXES.map((prefix) => `${prefix}${model}`).find((key) => keys.includes(key));
  if (prefixed !== undefined) return prefixed;
  const normalizedModel = normalize(model);
  const candidates = [...keys].sort().filter((key) => fuzzyMatches(normalizedModel, normalize(key)));
  return candidates.reduce<string | null>((best, key) => (best === null || key.length > best.length ? key : best), null);
}
