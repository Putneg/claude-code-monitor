import type { OverviewTotals } from '../../shared/api.js';
import { TOKEN_TYPE_META, TOKEN_TYPE_ORDER, type TokenTypeKey } from '../../shared/models.js';
import { formatPercent } from './format.js';

export interface TokenTypeRow {
  readonly key: TokenTypeKey;
  readonly label: string;
  readonly color: string;
  readonly tokens: number;
  readonly cost: number;
  readonly tokenShare: number;
  readonly costShare: number;
}

/** Token and cost shares per type, in the fixed order cache read, cache write, output, input. */
export function tokenTypeRows(totals: OverviewTotals): TokenTypeRow[] {
  const { tokens, cost } = totals;
  const byType: Readonly<Record<TokenTypeKey, { readonly tokens: number; readonly cost: number }>> = {
    cache_read: { tokens: tokens.cacheRead, cost: cost.cacheRead },
    cache_write: { tokens: tokens.cacheWrite5m + tokens.cacheWrite1h, cost: cost.cacheWrite },
    output: { tokens: tokens.output, cost: cost.output },
    input: { tokens: tokens.input, cost: cost.input },
  };
  const tokenTotal = TOKEN_TYPE_ORDER.reduce((sum, key) => sum + byType[key].tokens, 0);
  const costTotal = TOKEN_TYPE_ORDER.reduce((sum, key) => sum + byType[key].cost, 0);
  return TOKEN_TYPE_ORDER.map((key) => ({
    key,
    label: TOKEN_TYPE_META[key].label,
    color: TOKEN_TYPE_META[key].color,
    tokens: byType[key].tokens,
    cost: byType[key].cost,
    tokenShare: tokenTotal > 0 ? byType[key].tokens / tokenTotal : 0,
    costShare: costTotal > 0 ? byType[key].cost / costTotal : 0,
  }));
}

/** "cache reads = 97% of tokens but 60% of cost", for the cache types that have tokens. */
export function tokenInsights(rows: readonly TokenTypeRow[]): string[] {
  return rows
    .filter((row) => (row.key === 'cache_read' || row.key === 'cache_write') && row.tokenShare > 0)
    .map((row) => `${row.label}s = ${formatPercent(row.tokenShare, 0)} of tokens but ${formatPercent(row.costShare, 0)} of cost`);
}
