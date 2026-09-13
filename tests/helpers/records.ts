/** Server tool request counts; when either is set the record carries server_tool_use, with 0 for the other. */
interface RequestInput {
  readonly webSearchRequests?: number;
  readonly webFetchRequests?: number;
}

export interface IterationInput extends RequestInput {
  readonly type: string;
  readonly model?: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite5m?: number;
  readonly cacheWrite1h?: number;
}

export interface UsageInput extends RequestInput {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite5m?: number;
  readonly cacheWrite1h?: number;
  /** When set, emit only cache_creation_input_tokens (no cache_creation breakdown object). */
  readonly legacyCacheCreation?: number;
  /** Overrides cache_creation_input_tokens while keeping the breakdown object. */
  readonly cacheCreationTotal?: number;
  readonly speed?: string | null;
  readonly iterations?: readonly IterationInput[];
}

export interface AssistantInput {
  readonly messageId: string;
  readonly requestId?: string | null;
  readonly model: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly cwd?: string;
  readonly isSidechain?: boolean;
  readonly agentId?: string;
  readonly isApiErrorMessage?: boolean;
  readonly usage: UsageInput;
}

function tokenFields(u: IterationInput | UsageInput): Record<string, unknown> {
  const write5m = u.cacheWrite5m ?? 0;
  const write1h = u.cacheWrite1h ?? 0;
  const base = {
    input_tokens: u.input ?? 0,
    output_tokens: u.output ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
  };
  if ('legacyCacheCreation' in u && u.legacyCacheCreation !== undefined) {
    return { ...base, cache_creation_input_tokens: u.legacyCacheCreation };
  }
  const total = 'cacheCreationTotal' in u && u.cacheCreationTotal !== undefined ? u.cacheCreationTotal : write5m + write1h;
  return {
    ...base,
    cache_creation_input_tokens: total,
    cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
  };
}

function serverToolFields(u: RequestInput): Record<string, unknown> {
  if (u.webSearchRequests === undefined && u.webFetchRequests === undefined) return {};
  return { server_tool_use: { web_search_requests: u.webSearchRequests ?? 0, web_fetch_requests: u.webFetchRequests ?? 0 } };
}

function usageJson(u: UsageInput): Record<string, unknown> {
  const iterations = u.iterations?.map((it) => ({
    ...tokenFields(it),
    ...serverToolFields(it),
    type: it.type,
    ...(it.model === undefined ? {} : { model: it.model }),
  }));
  return {
    ...tokenFields(u),
    ...serverToolFields(u),
    service_tier: 'standard',
    speed: u.speed === undefined ? 'standard' : u.speed,
    ...(iterations === undefined ? {} : { iterations }),
  };
}

export function assistantLine(a: AssistantInput): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: a.isSidechain ?? false,
    ...(a.agentId === undefined ? {} : { agentId: a.agentId }),
    ...(a.requestId === null ? {} : { requestId: a.requestId ?? `req_${a.messageId}` }),
    type: 'assistant',
    uuid: `uuid-${a.messageId}`,
    timestamp: a.timestamp,
    sessionId: a.sessionId,
    cwd: a.cwd ?? '/home/dev/alpha',
    version: '2.1.247',
    ...(a.isApiErrorMessage === undefined ? {} : { isApiErrorMessage: a.isApiErrorMessage }),
    message: {
      model: a.model,
      id: a.messageId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: usageJson(a.usage),
    },
  });
}

export function titleLine(sessionId: string, title: string): string {
  return JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId });
}

export function userLine(sessionId: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp: '2026-09-10T12:00:00.000Z',
    message: { role: 'user', content: text },
  });
}
