/** The coding agents whose usage the monitor counts, in display order. */
export const CLIENTS = ['claude', 'codex'] as const;
export type Client = (typeof CLIENTS)[number];

/** Narrows an untrusted string (a URL parameter or a database value) to a known client. */
export const isClient = (value: string): value is Client => CLIENTS.some((client) => client === value);

export const MODEL_COLORS: Readonly<Record<string, string>> = {
  'gpt-6-astra': '#FF79C6',
  'gpt-5.6-sol': '#2BD9A5',
  'codex-auto-review': '#B8BB26',
  'opus-5': '#FFB000',
  'fable-5': '#5FD7D7',
  'fable-5.1': '#7AA2F7',
  'sonnet-5': '#8BD450',
  'opus-4.8': '#FF6B57',
  'opus-4.7': '#E0876A',
  'haiku-4.5': '#C792EA',
};

export const FALLBACK_PALETTE: readonly string[] = ['#F2C14E', '#56B6C2', '#E06C75', '#98C379', '#D19A66', '#61AFEF', '#C678DD', '#BE5046'];

export const PROJECT_PALETTE: readonly string[] = ['#FFB000', '#5FD7D7', '#7AA2F7', '#8BD450', '#FF6B57', '#C792EA', '#E0876A', '#56B6C2'];

/** The 'other' series and its legend dot: 3.6:1 on the page background, above the 3:1 minimum for graphics. */
export const OTHER_COLOR = '#6E6B60';

export type TokenTypeKey = 'cache_read' | 'cache_write' | 'output' | 'input';

export const TOKEN_TYPE_ORDER: readonly TokenTypeKey[] = ['cache_read', 'cache_write', 'output', 'input'];

export const TOKEN_TYPE_META: Readonly<Record<TokenTypeKey, { label: string; color: string }>> = {
  cache_read: { label: 'cache read', color: '#5FD7D7' },
  cache_write: { label: 'cache write', color: '#FFB000' },
  output: { label: 'output', color: '#8BD450' },
  input: { label: 'input', color: '#C792EA' },
};

/** claude-fable-5-1 -> fable-5.1, claude-haiku-4-5-20251001 -> haiku-4.5; other ids are shown as they are. */
export function modelLabel(modelId: string): string {
  if (!modelId.startsWith('claude-')) return modelId;
  return modelId
    .slice('claude-'.length)
    .replace(/-\d{8}$/, '')
    .replace(/(\d+)-(\d{1,2})$/, '$1.$2');
}

/** 32-bit FNV-1a hash, always non-negative. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function modelColor(modelId: string): string {
  const label = modelLabel(modelId);
  // Own keys only: a model id such as "claude-constructor" must not pick up Object.prototype members.
  const fixed = Object.hasOwn(MODEL_COLORS, label) ? MODEL_COLORS[label] : undefined;
  if (fixed) return fixed;
  return FALLBACK_PALETTE[hashString(modelId) % FALLBACK_PALETTE.length] ?? OTHER_COLOR;
}

/** Last two path segments: D:/src/x/team/app -> team/app */
export function projectLabel(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const label = segments.slice(-2).join('/');
  return label.length > 0 ? label : path;
}

export interface ClientMeta {
  readonly label: string;
  readonly color: string;
}

export const CLIENT_META: Readonly<Record<Client, ClientMeta>> = {
  claude: { label: 'claude code', color: '#FFB000' },
  codex: { label: 'codex', color: '#10A37F' },
};

/** Label and color for a client id read from the database; an unknown id keeps its name and gets the 'other' color. */
export function clientMeta(id: string): ClientMeta {
  return isClient(id) ? CLIENT_META[id] : { label: id, color: OTHER_COLOR };
}
