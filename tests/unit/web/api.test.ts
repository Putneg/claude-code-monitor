import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, createApiClient, describeError, REQUEST_TIMEOUT_MS, type FetchLike } from '../../../src/web/lib/api.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const STATUS_BODY = {
  now: 'n',
  today: '2026-09-11',
  tz: 'UTC',
  sync: {},
  backfill: {},
  sources: [],
  pricing: {},
  data: {},
  codexLimits: [],
};
const ACCEPT = { accept: 'application/json' };

/** Like fetch against a server that never answers: settles only when the signal aborts, with its reason. */
const hangingFetch: FetchLike = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });

/** Like a server that sends the headers and the start of the body, then stalls: the body fails when the signal aborts. */
const stalledBody: FetchLike = async (_input, init) => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"now":'));
      init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
};

describe('createApiClient', () => {
  it('requests JSON from the API paths', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(STATUS_BODY));
    await expect(createApiClient(fetchImpl).status()).resolves.toMatchObject({ today: '2026-09-11' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/status', { headers: ACCEPT, signal: expect.any(AbortSignal) });
  });

  it('appends the query and aborts the request with the caller signal', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ total: 0, sessions: [] }));
    const controller = new AbortController();
    await createApiClient(fetchImpl).sessions('from=2026-03-01&to=2026-03-14', controller.signal);
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    expect(input).toBe('/api/sessions?from=2026-03-01&to=2026-03-14');
    // The request gets a signal combined with the timeout, so it is not the caller's own; it follows it.
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });

  it('gives up after the timeout with the timeout code', async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
    await expect(createApiClient(hangingFetch, 20).status()).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 0,
      code: 'timeout',
      message: '/api/status timed out',
    });
  });

  it('passes a caller abort through before the timeout', async () => {
    const controller = new AbortController();
    const pending = createApiClient(hangingFetch).overview('from=2026-03-01&to=2026-03-14', controller.signal);
    controller.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('reports a timeout that cuts off the body as a timeout, not as a bad body', async () => {
    await expect(createApiClient(stalledBody, 20).status()).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 0,
      code: 'timeout',
      message: '/api/status timed out',
    });
  });

  it('passes a caller abort that cuts off the body through', async () => {
    const controller = new AbortController();
    const pending = createApiClient(stalledBody).overview('from=2026-03-01&to=2026-03-14', controller.signal);
    controller.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('still reports a complete body that is not valid JSON as a bad body', async () => {
    const truncated = createApiClient(async () => new Response('{"now":', { status: 200 }));
    await expect(truncated.status()).rejects.toMatchObject({ status: 200, code: 'bad_response' });
  });

  it('turns API errors into ApiRequestError with the server code', async () => {
    const client = createApiClient(async () => json({ error: 'invalid_query', details: {} }, 400));
    await expect(client.overview('bucket=hour')).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
      code: 'invalid_query',
      message: '/api/overview failed with HTTP 400',
    });
  });

  it('rejects bodies that are not JSON or lack required fields', async () => {
    await expect(createApiClient(async () => new Response('<html>', { status: 200 })).filters()).rejects.toMatchObject({
      code: 'bad_response',
    });
    await expect(createApiClient(async () => json({ models: [] })).filters()).rejects.toMatchObject({ code: 'bad_response' });
    await expect(createApiClient(async () => new Response('oops', { status: 502 })).filters()).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
    });
  });

  it('reports network failures and passes aborts through untouched', async () => {
    const offline = createApiClient(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(offline.status()).rejects.toMatchObject({ status: 0, code: 'network_error' });
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const aborted = createApiClient(async () => {
      throw abort;
    });
    await expect(aborted.status()).rejects.toBe(abort);
  });

  it('requires the client and Codex fields', async () => {
    const oldStatus = { now: 'n', today: '2026-09-11', tz: 'UTC', sync: {}, backfill: {}, sources: [], pricing: {}, data: {} };
    await expect(createApiClient(async () => json(oldStatus)).status()).rejects.toMatchObject({ code: 'bad_response' });
    await expect(createApiClient(async () => json({ models: [], projects: [], bounds: {} })).filters()).rejects.toMatchObject({
      code: 'bad_response',
    });
    const overview = { range: {}, totals: {}, series: {}, byModel: [], byProject: [] };
    await expect(createApiClient(async () => json(overview)).overview('x=1')).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('describeError', () => {
  it('uses the error message when there is one', () => {
    expect(describeError(new ApiRequestError(500, 'internal_error', '/api/overview failed with HTTP 500'))).toBe(
      '/api/overview failed with HTTP 500',
    );
    expect(describeError('boom')).toBe('unexpected error');
  });
});
