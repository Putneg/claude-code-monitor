import type { ClientBreakdown, Day, OverviewResponse, OverviewTotals } from '../../shared/api.js';
import { bucketLabel, formatPercent, formatTokens, formatUsd, formatUsdExact, plural, shortDay } from './format.js';
import { peakOf } from './series.js';
import type { Unit } from './view-state.js';

/** One key/value line; `strong` is rendered bold, `rest` follows it in the dim color. */
export interface HeroRow {
  readonly label: string;
  readonly strong: string;
  readonly rest: string;
  readonly muted: boolean;
}

export interface HeroView {
  readonly caption: string;
  readonly main: string;
  readonly rows: readonly HeroRow[];
}

const row = (label: string, strong: string, rest = '', muted = false): HeroRow => ({ label, strong, rest, muted });

const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

function comparisonRow(prev: number | null, current: number, days: number, firstDay: Day | null): HeroRow {
  const label = `vs prev ${days}d`;
  if (prev === null) return row(label, '', firstDay === null ? 'n/a' : `n/a — history starts ${shortDay(firstDay)}`, true);
  if (prev === 0) return row(label, '', `n/a — $0 in the previous ${days}d`, true);
  const delta = (current - prev) / prev;
  return row(label, `${delta >= 0 ? '▲' : '▼'} ${formatPercent(Math.abs(delta), 0)}`, ` · prev ${formatUsd(prev)}`);
}

/**
 * The $0.01-per-request fee and the request count, only when the range has web searches: Claude Code's own WebSearch
 * tool runs as a side request that transcripts do not record, so most ranges have none. Shown in both units.
 */
function webSearchRows(totals: OverviewTotals): HeroRow[] {
  return totals.webSearchRequests > 0
    ? [row('web search', formatUsd(totals.cost.webSearch), ` · ${plural(totals.webSearchRequests, 'request')}`)]
    : [];
}

/** Spend (or tokens) per client, only when the range has more than one client. */
function clientRows(overview: OverviewResponse, unit: Unit): HeroRow[] {
  if (overview.byClient.length < 2) return [];
  const amount = (item: ClientBreakdown): string => (unit === 'usd' ? formatUsd(item.cost) : formatTokens(item.tokensTotal));
  return [row('clients', '', overview.byClient.map((item) => `${item.label} ${amount(item)}`).join(' · '))];
}

/** SpendHero content: the caption, the big number and the rows under it. The unit switches the big number, average and peak. */
export function heroView(overview: OverviewResponse, unit: Unit, rangeText: string, firstDay: Day | null): HeroView {
  const { totals, range } = overview;
  const money = totals.cost.total;
  const inUnit = unit === 'usd' ? formatUsd : formatTokens;
  const peak = peakOf(overview.series, unit);
  const average = unit === 'usd' ? formatUsd(totals.avgCostPerDay) : formatTokens(totals.tokensTotal / Math.max(range.days, 1));
  return {
    caption: `${unit === 'usd' ? 'spend' : 'tokens'} · ${rangeText}`,
    main: unit === 'usd' ? formatUsdExact(money) : formatTokens(totals.tokensTotal),
    rows: [
      row('avg / day', average),
      peak === null ? row('peak', '', 'n/a', true) : row('peak', bucketLabel(peak.bucket), ` · ${inUnit(peak.value)}`),
      comparisonRow(totals.prevPeriodCost, money, range.days, firstDay),
      unit === 'usd' ? row('tokens', formatTokens(totals.tokensTotal)) : row('cost', formatUsdExact(money)),
      row('sessions', String(totals.sessions), ` in ${plural(totals.projects, 'project')}`),
      ...clientRows(overview, unit),
      row('subagents', formatPercent(share(totals.subagentCost, money), 0), ' of spend'),
      row('advisor', formatPercent(share(totals.advisorCost, money), 0), ` · ${formatUsd(totals.advisorCost)}`),
      ...webSearchRows(totals),
    ],
  };
}
