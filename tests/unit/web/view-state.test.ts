import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW,
  isChecked,
  parseViewState,
  serializeViewState,
  toggleModel,
  toggleProject,
  withCustomRange,
  withPreset,
  withSettings,
  type ViewState,
} from '../../../src/web/lib/view-state.js';

describe('parseViewState', () => {
  it('returns the default view for an empty query', () => {
    expect(parseViewState('')).toEqual(DEFAULT_VIEW);
  });

  it('reads every field', () => {
    expect(
      parseViewState('?from=2026-03-01&to=2026-03-14&models=a,b&projects=p1&unit=tok&stack=type&bucket=hour&cum=0&sort=recent'),
    ).toEqual({
      range: null,
      from: '2026-03-01',
      to: '2026-03-14',
      models: ['a', 'b'],
      projects: ['p1'],
      unit: 'tok',
      stack: 'type',
      bucket: 'hour',
      cumulative: false,
      sort: 'recent',
    });
  });

  it('falls back to defaults for invalid values', () => {
    expect(parseViewState('?range=forever&unit=eur&stack=x&bucket=week&sort=name&cum=maybe')).toEqual(DEFAULT_VIEW);
  });

  it('ignores an invalid, reversed or oversized custom range', () => {
    expect(parseViewState('?from=2026-02-30&to=2026-03-01').range).toBe('30d');
    expect(parseViewState('?from=2026-03-02&to=2026-03-01&range=7d')).toMatchObject({ range: '7d', from: null, to: null });
    expect(parseViewState('?from=2000-01-01&to=2026-03-01').range).toBe('30d');
  });

  it.each(['?from=1999-12-30&to=2000-01-05', '?from=2999-12-30&to=3000-01-02'])(
    'ignores %s, a custom range with a day the API does not accept',
    (search) => {
      expect(parseViewState(search)).toMatchObject({ range: '30d', from: null, to: null });
    },
  );

  it('accepts a custom range that ends on the last day the API accepts', () => {
    expect(parseViewState('?from=2999-12-01&to=2999-12-31')).toMatchObject({ range: null, from: '2999-12-01', to: '2999-12-31' });
  });

  it('cleans list parameters', () => {
    const tooLong = 'x'.repeat(201);
    const many = Array.from({ length: 150 }, (_, index) => `m${index}`).join(',');
    expect(parseViewState(`?models= a ,,a,b,${tooLong}`).models).toEqual(['a', 'b']);
    expect(parseViewState(`?models=${many}`).models).toHaveLength(100);
  });
});

describe('serializeViewState', () => {
  it('omits defaults', () => {
    expect(serializeViewState(DEFAULT_VIEW)).toBe('');
  });

  it('writes a canonical query that parses back to the same view', () => {
    const view: ViewState = {
      range: null,
      from: '2026-03-01',
      to: '2026-03-14',
      models: ['claude-opus-5', 'claude-sonnet-5'],
      projects: ['p 1'],
      unit: 'tok',
      stack: 'project',
      bucket: 'day',
      cumulative: false,
      sort: 'recent',
    };
    const search = serializeViewState(view);
    expect(search).toBe(
      'from=2026-03-01&to=2026-03-14&models=claude-opus-5,claude-sonnet-5&projects=p%201&unit=tok&stack=project&bucket=day&cum=0&sort=recent',
    );
    expect(parseViewState(`?${search}`)).toEqual(view);
  });

  it('writes a non-default preset', () => {
    expect(serializeViewState({ ...DEFAULT_VIEW, range: '7d' })).toBe('range=7d');
  });
});

describe('view updates', () => {
  it('resets the bucket to automatic when the range changes', () => {
    const hourly: ViewState = { ...DEFAULT_VIEW, bucket: 'hour' };
    expect(withPreset(hourly, 'today')).toMatchObject({ range: 'today', from: null, to: null, bucket: null });
    expect(withCustomRange(hourly, '2026-03-09', '2026-03-02')).toMatchObject({
      range: null,
      from: '2026-03-02',
      to: '2026-03-09',
      bucket: null,
    });
  });

  it('merges settings without touching the range or the input', () => {
    const next = withSettings(DEFAULT_VIEW, { unit: 'tok', stack: 'type' });
    expect(next).toMatchObject({ unit: 'tok', stack: 'type', range: '30d' });
    expect(DEFAULT_VIEW.unit).toBe('usd');
  });

  it('ignores a custom range longer than the API accepts', () => {
    expect(withCustomRange(DEFAULT_VIEW, '2000-01-01', '2026-03-01')).toBe(DEFAULT_VIEW);
  });
});

describe('model and project selection', () => {
  const all = ['a', 'b', 'c'];

  it('unchecking one model from "all" keeps the others in canonical order', () => {
    expect(toggleModel([], all, 'b')).toEqual(['a', 'c']);
  });

  it('re-checking the last missing model collapses to "all"', () => {
    expect(toggleModel(['a', 'c'], all, 'b')).toEqual([]);
  });

  it('never unchecks the last checked model', () => {
    expect(toggleModel(['a'], all, 'a')).toEqual(['a']);
  });

  it('ignores unknown ids that came from the URL', () => {
    expect(toggleModel(['zzz'], all, 'a')).toEqual(['a']);
  });

  it('reports checked state', () => {
    expect(isChecked([], 'a')).toBe(true);
    expect(isChecked(['b'], 'a')).toBe(false);
  });

  it('toggles projects, where empty means all', () => {
    expect(toggleProject([], 'p1')).toEqual(['p1']);
    expect(toggleProject(['p1', 'p2'], 'p1')).toEqual(['p2']);
  });
});
