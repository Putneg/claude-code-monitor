import { describe, expect, it } from 'vitest';
import { historyAction } from '../../../src/web/lib/history.js';
import { parseViewState, serializeViewState } from '../../../src/web/lib/view-state.js';

describe('historyAction', () => {
  it('does nothing when the query is unchanged', () => {
    expect(historyAction('?from=2026-03-01&to=2026-03-14', '?from=2026-03-01&to=2026-03-14')).toBe('none');
    expect(historyAction('', '')).toBe('none');
    expect(historyAction('?unit=tok', 'unit=tok')).toBe('none');
  });

  it('pushes a new range: a preset, typed dates or a zoom', () => {
    expect(historyAction('', '?range=all')).toBe('push');
    expect(historyAction('?range=7d', '?from=2026-03-01&to=2026-03-14')).toBe('push');
    expect(historyAction('?from=2026-03-01&to=2026-03-14', '?from=2026-03-05&to=2026-03-09')).toBe('push');
    expect(historyAction('?from=2026-03-01&to=2026-03-14&unit=tok', '?from=2026-03-01&to=2026-03-10&unit=tok')).toBe('push');
  });

  it('replaces the entry for every other view change', () => {
    expect(historyAction('?from=2026-03-01&to=2026-03-14', '?from=2026-03-01&to=2026-03-14&unit=tok')).toBe('replace');
    expect(historyAction('?range=all', '?range=all&stack=type')).toBe('replace');
  });

  it('treats a missing or invalid range as the default preset', () => {
    expect(historyAction('?range=30d', '')).toBe('replace');
    expect(historyAction('?range=bogus&unit=tok', '?unit=tok')).toBe('replace');
  });

  it('never pushes when the view is re-read from a URL already in history', () => {
    // popstate sets the view from the URL; the URL effect then rewrites it canonically. A push there would add an
    // entry on every Back and trap the user.
    const stored = [
      '',
      '?range=bogus',
      '?range=all',
      '?from=2026-03-14&to=2026-03-01',
      '?from=2026-03-01',
      '?models=a,b&unit=tok&from=2026-03-01&to=2026-03-14',
    ];
    for (const search of stored) {
      const canonical = serializeViewState(parseViewState(search));
      expect(historyAction(search, canonical.length > 0 ? `?${canonical}` : '')).not.toBe('push');
    }
  });
});
