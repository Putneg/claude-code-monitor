import { parseViewState } from './view-state.js';

export type HistoryAction = 'push' | 'replace' | 'none';

const withoutQuestionMark = (search: string): string => (search.startsWith('?') ? search.slice(1) : search);

/**
 * The effective range of a query string, as parseViewState reads it: a missing or invalid range is the default
 * preset, and an unusable from/to pair is ignored. Comparing parsed ranges, not raw parameters, means that re-reading
 * any URL from history never looks like a new range.
 */
function rangeOf(search: string): string {
  const view = parseViewState(search);
  return [view.range ?? '', view.from ?? '', view.to ?? ''].join('|');
}

/**
 * How the address bar follows a view change. A new range (preset, typed dates or a zoom) pushes a history entry, so
 * Back returns to the previous range; any other change replaces the current entry. Both arguments are
 * location.search strings, with or without the leading '?'.
 */
export function historyAction(currentSearch: string, nextSearch: string): HistoryAction {
  if (withoutQuestionMark(currentSearch) === withoutQuestionMark(nextSearch)) return 'none';
  return rangeOf(currentSearch) === rangeOf(nextSearch) ? 'replace' : 'push';
}
