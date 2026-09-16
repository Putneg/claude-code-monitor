import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRICING_URL_RULE } from '../../src/server/config.js';
import { createLogger } from '../../src/server/logger.js';
import { createFetchPayload, createPricingService, PRICING_MAX_BYTES, type PricingDeps } from '../../src/server/pricing/refresher.js';
import type { PriceSnapshot } from '../../src/server/pricing/types.js';
import { createTestDb } from '../helpers/db.js';

const SNAPSHOT: PriceSnapshot = {
  fetchedAt: '2026-09-01T00:00:00.000Z',
  prices: {
    'claude-opus-5': { input: 5e-6, output: 2.5e-5, cacheWrite5m: 6.25e-6, cacheWrite1h: 1e-5, cacheRead: 5e-7, fastMultiplier: 2 },
  },
};

/** A later embedded snapshot that also prices claude-sonnet-5. */
const NEWER_SNAPSHOT: PriceSnapshot = {
  fetchedAt: '2026-09-05T00:00:00.000Z',
  prices: {
    ...SNAPSHOT.prices,
    'claude-sonnet-5': { input: 2e-6, output: 1e-5, cacheWrite5m: 2.5e-6, cacheWrite1h: 4e-6, cacheRead: 2e-7, fastMultiplier: 1 },
  },
};

const LITELLM_PAYLOAD = {
  'claude-opus-5': { litellm_provider: 'anthropic', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 },
  'claude-sonnet-5': { litellm_provider: 'anthropic', input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
};

function setup(overrides: Partial<PricingDeps> = {}) {
  const { repos } = createTestDb();
  const fetchPayload = vi.fn(async () => LITELLM_PAYLOAD as unknown);
  const deps: PricingDeps = {
    prices: repos.prices,
    fetchPayload,
    snapshot: SNAPSHOT,
    logger: createLogger('silent'),
    now: () => Date.parse('2026-09-11T00:00:00Z'),
    refreshMs: 86_400_000,
    retryMs: 3_600_000,
    ...overrides,
  };
  return { repos, fetchPayload, service: createPricingService(deps) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PricingService', () => {
  it('loads the embedded snapshot when no prices are stored', () => {
    const { service, repos } = setup();
    expect(service.state()).toEqual({ source: 'none', fetchedAt: null, unpricedModels: [] });
    service.ensureLoaded();
    expect(repos.prices.keys()).toEqual(['claude-opus-5']);
    expect(service.state()).toMatchObject({ source: 'snapshot', fetchedAt: '2026-09-01T00:00:00.000Z' });
  });

  it('does not overwrite stored prices with the snapshot', async () => {
    const { service, repos } = setup();
    await service.refresh();
    service.ensureLoaded();
    expect(repos.prices.sourceInfo()?.source).toBe('litellm');
  });

  it('refreshes from LiteLLM and remaps registered models', async () => {
    const { service, repos } = setup();
    service.ensureLoaded();
    service.ensureMapped(['claude-sonnet-5', 'claude-opus-5']);
    expect(service.state().unpricedModels).toEqual(['claude-sonnet-5']);
    expect(await service.refresh()).toBe(true);
    expect(repos.prices.keys()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(service.state()).toEqual({ source: 'litellm', fetchedAt: '2026-09-11T00:00:00.000Z', unpricedModels: [] });
  });

  it('keeps existing prices when a refresh fails', async () => {
    const { service, repos } = setup({
      fetchPayload: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    expect(await service.refresh()).toBe(false);
    expect(repos.prices.sourceInfo()?.source).toBe('snapshot');
  });

  it('rejects a payload without Anthropic prices', async () => {
    const { service } = setup({ fetchPayload: vi.fn(async () => ({ 'gpt-x': { litellm_provider: 'openai' } })) });
    expect(await service.refresh()).toBe(false);
    expect(service.state().source).toBe('snapshot');
  });

  it('maps only models it has not seen before', () => {
    const { service, repos } = setup();
    service.ensureLoaded();
    const spy = vi.spyOn(repos.prices, 'setMappings');
    service.ensureMapped(['claude-opus-5', 'claude-opus-5']);
    service.ensureMapped(['claude-opus-5']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith([{ model: 'claude-opus-5', priceKey: 'claude-opus-5' }], expect.any(Number));
  });

  it('replaces an older stored snapshot with the newer embedded one and maps registered models', () => {
    const logger = createLogger('silent');
    const info = vi.spyOn(logger, 'info');
    const { service, repos } = setup({ logger, snapshot: NEWER_SNAPSHOT });
    repos.prices.replaceAll(SNAPSHOT.prices, 'snapshot', Date.parse(SNAPSHOT.fetchedAt));
    repos.prices.setMappings([{ model: 'claude-sonnet-5', priceKey: null }], 0);
    service.ensureLoaded();
    expect(repos.prices.keys()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(service.state()).toEqual({ source: 'snapshot', fetchedAt: '2026-09-05T00:00:00.000Z', unpricedModels: [] });
    expect(info).toHaveBeenCalledWith({ entries: 2 }, 'upgraded the embedded price snapshot');
  });

  it('keeps a stored snapshot that is as new as the embedded one', () => {
    const { service, repos } = setup({ snapshot: NEWER_SNAPSHOT });
    repos.prices.replaceAll(SNAPSHOT.prices, 'snapshot', Date.parse(NEWER_SNAPSHOT.fetchedAt));
    service.ensureLoaded();
    expect(repos.prices.keys()).toEqual(['claude-opus-5']);
  });

  it('never replaces LiteLLM prices with the snapshot, even an older fetch', () => {
    const { service, repos } = setup({ snapshot: NEWER_SNAPSHOT });
    repos.prices.replaceAll(SNAPSHOT.prices, 'litellm', Date.parse('2026-08-01T00:00:00Z'));
    service.ensureLoaded();
    expect(repos.prices.sourceInfo()).toEqual({ source: 'litellm', fetchedAt: Date.parse('2026-08-01T00:00:00Z') });
  });

  it('keeps the stored price of a registered model whose key vanished from LiteLLM', async () => {
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    const fetchPayload = vi.fn(async () => ({ 'claude-sonnet-5': LITELLM_PAYLOAD['claude-sonnet-5'] }));
    const { service, repos } = setup({ logger, fetchPayload });
    service.ensureLoaded();
    service.ensureMapped(['claude-opus-5']);
    expect(await service.refresh()).toBe(true);
    expect(repos.prices.keys()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(repos.prices.all()['claude-opus-5']).toEqual(SNAPSHOT.prices['claude-opus-5']);
    expect(service.state()).toEqual({ source: 'litellm', fetchedAt: '2026-09-11T00:00:00.000Z', unpricedModels: [] });
    expect(warn).toHaveBeenCalledWith({ count: 1 }, 'kept prices for models missing from the new price table');
  });

  it('drops a vanished key that no registered model uses', async () => {
    const fetchPayload = vi.fn(async () => ({ 'claude-sonnet-5': LITELLM_PAYLOAD['claude-sonnet-5'] }));
    const { service, repos } = setup({ fetchPayload });
    service.ensureLoaded();
    service.ensureMapped(['claude-sonnet-5']);
    expect(await service.refresh()).toBe(true);
    expect(repos.prices.keys()).toEqual(['claude-sonnet-5']);
    expect(service.state().unpricedModels).toEqual([]);
  });

  it('lists at most 20 tiered keys in its warning and counts them all', async () => {
    const tiered = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `claude-tiered-${String(index).padStart(2, '0')}`,
        { ...LITELLM_PAYLOAD['claude-opus-5'], input_cost_per_token_above_200k_tokens: 1e-5 },
      ]),
    );
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    const { service } = setup({ logger, fetchPayload: vi.fn(async () => tiered) });
    expect(await service.refresh()).toBe(true);
    const keys = Object.keys(tiered).slice(0, 20);
    expect(warn).toHaveBeenCalledWith({ keys, count: 25 }, 'tiered (long-context) pricing is not supported; base rates are used');
  });

  it('keeps existing prices when the price request is redirected to plain http', async () => {
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    const fetchImpl = vi.fn(async () => redirectedResponse(JSON.stringify(LITELLM_PAYLOAD), 'http://example.com/prices.json'));
    const { service, repos } = setup({ logger, fetchPayload: createFetchPayload('https://example.test/prices.json', 500, fetchImpl) });
    service.ensureLoaded();
    expect(await service.refresh()).toBe(false);
    expect(repos.prices.keys()).toEqual(['claude-opus-5']);
    expect(service.state()).toMatchObject({ source: 'snapshot', fetchedAt: '2026-09-01T00:00:00.000Z' });
    expect(warn).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: expect.stringContaining(PRICING_URL_RULE) }) },
      'price refresh failed; keeping existing prices',
    );
  });

  it('schedules refreshes with success and retry intervals', async () => {
    vi.useFakeTimers();
    const fetchPayload = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(LITELLM_PAYLOAD);
    const { service } = setup({ fetchPayload, refreshMs: 10_000, retryMs: 1_000 });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchPayload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchPayload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchPayload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchPayload).toHaveBeenCalledTimes(3);
    service.stop();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchPayload).toHaveBeenCalledTimes(3);
  });
});

/** A body of `count` chunks of `bytes` bytes each, pulled only when read; it counts pulls and records cancel. */
function chunkedBody(count: number, bytes: number) {
  const chunk = new Uint8Array(bytes).fill(0x20);
  const cancel = vi.fn();
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        pulls += 1;
        if (pulls > count) controller.close();
        else controller.enqueue(chunk);
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return { stream, cancel, pulls: () => pulls };
}

/** A response as fetch returns it after following redirects to `url`; the Response constructor cannot set either field. */
function redirectedResponse(body: ConstructorParameters<typeof Response>[0], url: string): Response {
  return Object.defineProperties(new Response(body), { redirected: { value: true }, url: { value: url } });
}

describe('createFetchPayload', () => {
  it('returns parsed JSON for successful responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"a":1}', { status: 200 }));
    await expect(createFetchPayload('https://example.test/prices.json', 500, fetchImpl)()).resolves.toEqual({ a: 1 });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/prices.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('throws on HTTP errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl)()).rejects.toThrow('HTTP 503');
  });

  it('caps the body at 20 MB by default', () => {
    expect(PRICING_MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  it('accepts a body of exactly maxBytes', async () => {
    const fetchImpl = vi.fn(async () => new Response('"12345678"'));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl, 10)()).resolves.toBe('12345678');
  });

  it('refuses a declared content-length above maxBytes', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-length': '11' } }));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl, 10)()).rejects.toThrow(
      'Pricing response exceeds 10 bytes',
    );
  });

  it('stops reading a body without content-length once it passes maxBytes', async () => {
    const fetchImpl = vi.fn(async () => new Response('"123456789"'));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl, 10)()).rejects.toThrow(
      'Pricing response exceeds 10 bytes',
    );
  });

  it('rejects a response without a body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl)()).rejects.toThrow('Pricing response has no body');
  });

  it('releases the body of an HTTP error response', async () => {
    const body = chunkedBody(1, 4);
    const fetchImpl = vi.fn(async () => new Response(body.stream, { status: 503 }));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl)()).rejects.toThrow('HTTP 503');
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts a body that starts with a UTF-8 byte order mark', async () => {
    const fetchImpl = vi.fn(async () => new Response('﻿{"a":1}'));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl)()).resolves.toEqual({ a: 1 });
  });

  it('stops pulling a streamed body once the running total passes maxBytes, and cancels it', async () => {
    const body = chunkedBody(10, 4);
    const fetchImpl = vi.fn(async () => new Response(body.stream));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl, 10)()).rejects.toThrow(
      'Pricing response exceeds 10 bytes',
    );
    // 4 + 4 + 4 = 12 bytes: the third of ten chunks passes the cap.
    expect(body.pulls()).toBe(3);
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to plain http and cancels its body', async () => {
    const body = chunkedBody(1, 4);
    const fetchImpl = vi.fn(async () => redirectedResponse(body.stream, 'http://example.com/prices.json'));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl)()).rejects.toThrow(PRICING_URL_RULE);
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to another https URL', async () => {
    const fetchImpl = vi.fn(async () => redirectedResponse('{"a":1}', 'https://mirror.example.test/p.json'));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl)()).resolves.toEqual({ a: 1 });
  });

  it('applies PRICING_MAX_BYTES when no maxBytes is given', async () => {
    const mebibyte = 1024 * 1024;
    const chunksAtCap = PRICING_MAX_BYTES / mebibyte;
    const body = chunkedBody(chunksAtCap + 1, mebibyte);
    const fetchImpl = vi.fn(async () => new Response(body.stream));
    await expect(createFetchPayload('https://example.test/p.json', 500, fetchImpl)()).rejects.toThrow(
      `Pricing response exceeds ${PRICING_MAX_BYTES} bytes`,
    );
    // The chunks that fill exactly the cap are read; the next one passes it and stops the read.
    expect(body.pulls()).toBe(chunksAtCap + 1);
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });
});
