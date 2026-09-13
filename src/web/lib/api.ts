import type { FiltersResponse, OverviewResponse, SessionsResponse, StatusResponse } from '../../shared/api.js';

export type FetchLike = (
  input: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal },
) => Promise<Response>;

/** Every request is aborted after this long, so a hung server cannot stall the status poll. */
export const REQUEST_TIMEOUT_MS = 10_000;

export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  /** HTTP status, or 0 when the server could not be reached or did not answer in time. */
  readonly status: number;
  /** The API's `error` field, or network_error / timeout / http_error / bad_response. */
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
    this.code = code;
  }
}

export interface ApiClient {
  status(signal?: AbortSignal): Promise<StatusResponse>;
  filters(signal?: AbortSignal): Promise<FiltersResponse>;
  overview(query: string, signal?: AbortSignal): Promise<OverviewResponse>;
  sessions(query: string, signal?: AbortSignal): Promise<SessionsResponse>;
}

/** Top-level fields each response must have before the UI trusts it. */
const REQUIRED_KEYS = {
  status: ['today', 'tz', 'sync', 'backfill', 'sources', 'pricing', 'data'],
  filters: ['models', 'projects', 'bounds'],
  overview: ['range', 'totals', 'series', 'byModel', 'byProject'],
  sessions: ['total', 'sessions'],
} as const;

const ACCEPT_JSON = { accept: 'application/json' } as const;

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

const hasKeys = (body: unknown, keys: readonly string[]): boolean =>
  typeof body === 'object' && body !== null && keys.every((key) => key in body);

function errorCode(body: unknown): string {
  const code = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof code === 'string' ? code : 'http_error';
}

/**
 * A body that is not JSON becomes null, which the callers report as http_error or bad_response. A read that the
 * request's signal cut off (the caller's abort or the timeout) is not a bad body: its error is rethrown.
 */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

/**
 * The error for a fetch or body read that threw. Once the caller has aborted (a newer load replaced this one), whatever
 * was thrown passes through untouched: the caller ignores the outcome. The timeout is a failure, and any other error
 * means the server could not be reached.
 */
function requestFailure(error: unknown, endpoint: string, caller: AbortSignal | undefined, timeout: AbortSignal): unknown {
  if (isAbortError(error) || caller?.aborted === true) return error;
  if (timeout.aborted) return new ApiRequestError(0, 'timeout', `${endpoint} timed out`, { cause: error });
  return new ApiRequestError(0, 'network_error', 'the claude-code-monitor API is unreachable', { cause: error });
}

/** `timeoutMs` exists for tests; the dashboard uses REQUEST_TIMEOUT_MS. */
export function createApiClient(fetchImpl: FetchLike = (input, init) => fetch(input, init), timeoutMs = REQUEST_TIMEOUT_MS): ApiClient {
  async function getJson<T>(path: string, keys: readonly string[], signal?: AbortSignal): Promise<T> {
    const endpoint = path.split('?')[0] ?? path;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    let body: unknown;
    try {
      response = await fetchImpl(path, { headers: ACCEPT_JSON, signal: combined });
      // The signal stays on the body, so the timeout or an abort can also land while it is read.
      body = await readJson(response, combined);
    } catch (error) {
      throw requestFailure(error, endpoint, signal, timeout);
    }
    if (!response.ok) throw new ApiRequestError(response.status, errorCode(body), `${endpoint} failed with HTTP ${response.status}`);
    if (!hasKeys(body, keys)) throw new ApiRequestError(response.status, 'bad_response', `${endpoint} returned an unexpected body`);
    return body as T;
  }

  return {
    status: (signal) => getJson<StatusResponse>('/api/status', REQUIRED_KEYS.status, signal),
    filters: (signal) => getJson<FiltersResponse>('/api/filters', REQUIRED_KEYS.filters, signal),
    overview: (query, signal) => getJson<OverviewResponse>(`/api/overview?${query}`, REQUIRED_KEYS.overview, signal),
    sessions: (query, signal) => getJson<SessionsResponse>(`/api/sessions?${query}`, REQUIRED_KEYS.sessions, signal),
  };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected error';
}
