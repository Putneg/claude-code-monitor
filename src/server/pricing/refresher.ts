import type { PricingStatus } from '../../shared/api.js';
import { isAllowedPricingUrl, PRICING_URL_RULE } from '../config.js';
import type { ModelMapping, PriceRepo, StoredPriceSource } from '../db/price-repo.js';
import type { Logger } from '../logger.js';
import { normalizeLiteLlm } from './litellm.js';
import { resolvePriceKey } from './resolve.js';
import type { PriceSnapshot, PriceTable } from './types.js';

export const PRICING_TIMEOUT_MS = 10_000;
export const PRICING_RETRY_MS = 3_600_000;
/** Upper bound for a pricing response body; the LiteLLM price list is far smaller. */
export const PRICING_MAX_BYTES = 20 * 1024 * 1024;
/** How many tiered-price keys one warning lists; the rest are only counted. */
export const MAX_LOGGED_KEYS = 20;

export interface PricingDeps {
  readonly prices: PriceRepo;
  readonly fetchPayload: () => Promise<unknown>;
  readonly snapshot: PriceSnapshot;
  readonly logger: Logger;
  readonly now: () => number;
  readonly refreshMs: number;
  readonly retryMs: number;
}

export interface PricingService {
  ensureLoaded(): void;
  refresh(): Promise<boolean>;
  ensureMapped(models: Iterable<string>): void;
  state(): PricingStatus;
  start(): void;
  stop(): void;
}

/** Reads the body as UTF-8 without a leading byte order mark, refusing a declared or actual size above `maxBytes`. */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = (): Error => new Error(`Pricing response exceeds ${maxBytes} bytes`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) throw new Error('Pricing response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new TextDecoder().decode(Buffer.concat(chunks));
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
}

export function createFetchPayload(
  url: string,
  timeoutMs: number = PRICING_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
  maxBytes: number = PRICING_MAX_BYTES,
): () => Promise<unknown> {
  return async () => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    // fetch follows redirects, so the URL the body came from is checked against the same rule as PRICING_URL.
    if (response.redirected && !isAllowedPricingUrl(response.url)) {
      await response.body?.cancel();
      throw new Error(`Pricing request was redirected to a URL that breaks the PRICING_URL rule: ${PRICING_URL_RULE}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Pricing request failed with HTTP ${response.status}`);
    }
    const payload: unknown = JSON.parse(await readBody(response, maxBytes));
    return payload;
  };
}

function resolveMappings(keys: readonly string[], models: readonly string[]): ModelMapping[] {
  return models.map((model) => ({ model, priceKey: resolvePriceKey(model, keys) }));
}

interface Replacement {
  readonly prices: PriceTable;
  readonly mappings: readonly ModelMapping[];
  /** Stored entries kept because a registered model still uses them and the new table lacks them. */
  readonly carried: number;
}

/**
 * The new table plus every stored entry that a registered model uses but `next` lacks, so a key that vanishes
 * upstream (or fails validation) never reprices that model's history to $0. The stored mappings always equal
 * resolvePriceKey over the stored keys, because every replacement writes the mappings it resolved in the same
 * transaction, and ensureMapped resolves over the stored keys too.
 */
function planReplacement(prices: PriceRepo, next: PriceTable): Replacement {
  const current = prices.all();
  const models = prices.allModels().map((m) => m.model);
  const inUse = new Set(resolveMappings(Object.keys(current), models).map((m) => m.priceKey));
  const carried = Object.entries(current).filter(([key]) => inUse.has(key) && !Object.hasOwn(next, key));
  const merged: PriceTable = { ...Object.fromEntries(carried), ...next };
  return { prices: merged, mappings: resolveMappings(Object.keys(merged), models), carried: carried.length };
}

/** Replaces the price table and every mapping in one transaction, keeping entries registered models still use. */
function replacePrices(deps: Pick<PricingDeps, 'prices' | 'logger'>, next: PriceTable, source: StoredPriceSource, fetchedAt: number): void {
  const plan = planReplacement(deps.prices, next);
  deps.prices.replaceAll(plan.prices, source, fetchedAt, plan.mappings);
  if (plan.carried > 0) {
    deps.logger.warn({ count: plan.carried }, 'kept prices for models missing from the new price table');
  }
}

function readState(prices: PriceRepo): PricingStatus {
  const info = prices.sourceInfo();
  return {
    source: info?.source ?? 'none',
    fetchedAt: info ? new Date(info.fetchedAt).toISOString() : null,
    unpricedModels: prices.unpricedModels(),
  };
}

/** Runs `refresh` now, then `refreshMs` after a success or `retryMs` after a failure. */
function createRefreshLoop(
  refresh: () => Promise<boolean>,
  deps: Pick<PricingDeps, 'refreshMs' | 'retryMs' | 'logger'>,
): { start(): void; stop(): void } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      void refresh()
        .catch((error: unknown) => {
          deps.logger.error({ err: error }, 'price refresh crashed');
          return false;
        })
        .then((ok) => {
          if (!stopped) schedule(ok ? deps.refreshMs : deps.retryMs);
        });
    }, delayMs);
  };
  return {
    start: () => {
      stopped = false;
      schedule(0);
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function createPricingService(deps: PricingDeps): PricingService {
  /** Loads the embedded snapshot into an empty table, or over an older stored snapshot (offline upgrades). */
  const ensureLoaded = (): void => {
    const stored = deps.prices.sourceInfo();
    const snapshotAt = Date.parse(deps.snapshot.fetchedAt);
    const entries = Object.keys(deps.snapshot.prices).length;
    if (stored === null) {
      replacePrices(deps, deps.snapshot.prices, 'snapshot', snapshotAt);
      deps.logger.info({ entries }, 'loaded embedded price snapshot');
    } else if (stored.source === 'snapshot' && stored.fetchedAt < snapshotAt) {
      replacePrices(deps, deps.snapshot.prices, 'snapshot', snapshotAt);
      deps.logger.info({ entries }, 'upgraded the embedded price snapshot');
    }
  };

  const refresh = async (): Promise<boolean> => {
    try {
      const { prices, tieredKeys } = normalizeLiteLlm(await deps.fetchPayload());
      const entries = Object.keys(prices).length;
      if (entries === 0) throw new Error('LiteLLM payload contains no Anthropic or OpenAI prices');
      replacePrices(deps, prices, 'litellm', deps.now());
      if (tieredKeys.length > 0) {
        deps.logger.warn(
          { keys: tieredKeys.slice(0, MAX_LOGGED_KEYS), count: tieredKeys.length },
          'tiered (long-context) pricing is not supported; base rates are used',
        );
      }
      deps.logger.info({ entries }, 'refreshed LiteLLM prices');
      return true;
    } catch (error) {
      deps.logger.warn({ err: error }, 'price refresh failed; keeping existing prices');
      ensureLoaded();
      return false;
    }
  };

  const ensureMapped = (models: Iterable<string>): void => {
    const mapped = deps.prices.mappedModels();
    const fresh = [...new Set(models)].filter((model) => !mapped.has(model));
    if (fresh.length > 0) deps.prices.setMappings(resolveMappings(deps.prices.keys(), fresh), deps.now());
  };

  const loop = createRefreshLoop(refresh, deps);
  const state = (): PricingStatus => readState(deps.prices);
  return { ensureLoaded, refresh, ensureMapped, state, start: loop.start, stop: loop.stop };
}
