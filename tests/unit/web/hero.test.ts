import { describe, expect, it } from 'vitest';
import { heroView } from '../../../src/web/lib/hero.js';
import { makeOverview, SERIES } from './fixtures.js';

const withTotals = (patch: Partial<ReturnType<typeof makeOverview>['totals']>) =>
  makeOverview({ totals: { ...makeOverview().totals, ...patch } });

describe('heroView', () => {
  it('builds the dollar view', () => {
    expect(heroView(makeOverview(), 'usd', '30d', '2026-08-01')).toEqual({
      caption: 'spend · 30d',
      main: '$8.00',
      rows: [
        { label: 'avg / day', strong: '$2.67', rest: '', muted: false },
        { label: 'peak', strong: '03-02', rest: ' · $5.00', muted: false },
        { label: 'vs prev 3d', strong: '▲ 100%', rest: ' · prev $4.00', muted: false },
        { label: 'tokens', strong: '1k', rest: '', muted: false },
        { label: 'sessions', strong: '3', rest: ' in 2 projects', muted: false },
        { label: 'subagents', strong: '25%', rest: ' of spend', muted: false },
        { label: 'advisor', strong: '5%', rest: ' · $0.40', muted: false },
      ],
    });
  });

  it('switches the main number, average and peak to tokens', () => {
    const hero = heroView(makeOverview(), 'tok', '03-01 → 03-03', null);
    expect(hero.caption).toBe('tokens · 03-01 → 03-03');
    expect(hero.main).toBe('1k');
    expect(hero.rows[0]).toEqual({ label: 'avg / day', strong: '417', rest: '', muted: false });
    expect(hero.rows[1]).toEqual({ label: 'peak', strong: '03-02', rest: ' · 1k', muted: false });
    expect(hero.rows[3]).toEqual({ label: 'cost', strong: '$8.00', rest: '', muted: false });
  });

  it('explains a missing comparison period', () => {
    const noPrev = withTotals({ prevPeriodCost: null });
    expect(heroView(noPrev, 'usd', '30d', '2026-08-11').rows[2]).toEqual({
      label: 'vs prev 3d',
      strong: '',
      rest: 'n/a — history starts 08-11',
      muted: true,
    });
    expect(heroView(noPrev, 'usd', '30d', null).rows[2]).toMatchObject({ rest: 'n/a', muted: true });
    expect(heroView(withTotals({ prevPeriodCost: 0 }), 'usd', '30d', null).rows[2]).toMatchObject({
      rest: 'n/a — $0 in the previous 3d',
      muted: true,
    });
  });

  it('shows a falling spend and copes with an all-zero period', () => {
    expect(heroView(withTotals({ prevPeriodCost: 16 }), 'usd', '30d', null).rows[2]).toMatchObject({ strong: '▼ 50%' });
    const flat = makeOverview({
      series: {
        ...SERIES,
        cost: [
          [0, 0, 0],
          [0, 0, 0],
        ],
      },
      totals: { ...makeOverview().totals, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0, total: 0 } },
    });
    expect(heroView(flat, 'usd', '30d', null).rows[1]).toEqual({ label: 'peak', strong: '', rest: 'n/a', muted: true });
    expect(heroView(flat, 'usd', '30d', null).rows[5]).toMatchObject({ strong: '0%' });
  });

  it('adds a web search row only when the range has search requests', () => {
    const searched = withTotals({ webSearchRequests: 2, cost: { ...makeOverview().totals.cost, webSearch: 0.02 } });
    expect(heroView(searched, 'usd', '30d', null).rows.at(-1)).toEqual({
      label: 'web search',
      strong: '$0.02',
      rest: ' · 2 requests',
      muted: false,
    });
    expect(heroView(searched, 'tok', '30d', null).rows.at(-1)).toMatchObject({ label: 'web search', rest: ' · 2 requests' });
    expect(heroView(makeOverview(), 'usd', '30d', null).rows.map((heroRow) => heroRow.label)).not.toContain('web search');
  });
});
