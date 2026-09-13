import { describe, expect, it } from 'vitest';
import {
  overviewQuerySchema,
  parseQuery,
  QueryError,
  resolveBucket,
  resolveFilter,
  sessionsQuerySchema,
} from '../../src/server/http/params.js';

describe('parseQuery', () => {
  it('applies defaults and splits lists', () => {
    expect(parseQuery(overviewQuerySchema, { models: 'a, b,,', from: '2026-09-01' })).toEqual({
      from: '2026-09-01',
      models: ['a', 'b'],
      projects: [],
      stack: 'model',
    });
    expect(parseQuery(sessionsQuerySchema, {})).toEqual({ models: [], projects: [], sort: 'cost', limit: 50 });
  });

  it('accepts days from 2000-01-01 to 2999-12-31', () => {
    expect(parseQuery(overviewQuerySchema, { from: '2000-01-01', to: '2999-12-31' })).toMatchObject({
      from: '2000-01-01',
      to: '2999-12-31',
    });
  });

  it.each(['1999-12-31', '3000-01-01', '9999-12-31'])('rejects the day %s', (value) => {
    expect(() => parseQuery(overviewQuerySchema, { from: value })).toThrow(QueryError);
    expect(() => parseQuery(sessionsQuerySchema, { to: value })).toThrow(QueryError);
  });

  it('reports field errors', () => {
    try {
      parseQuery(sessionsQuerySchema, { from: '2026-02-30', limit: '0', sort: 'weird' });
      expect.unreachable('expected a QueryError');
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      expect(Object.keys((error as QueryError).details as object).sort()).toEqual(['from', 'limit', 'sort']);
    }
  });
});

describe('resolveFilter', () => {
  it('defaults to the last 30 days ending today', () => {
    expect(resolveFilter({ models: [], projects: [] }, '2026-09-11')).toEqual({
      from: '2026-08-13',
      to: '2026-09-11',
      models: [],
      projects: [],
    });
  });

  it('keeps an explicit range and rejects inverted or huge ranges', () => {
    expect(resolveFilter({ from: '2026-09-01', to: '2026-09-02', models: ['m'], projects: [] }, '2026-09-11')).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-02',
      models: ['m'],
    });
    expect(() => resolveFilter({ from: '2026-09-03', to: '2026-09-02', models: [], projects: [] }, '2026-09-11')).toThrow(QueryError);
    expect(() => resolveFilter({ from: '2000-01-01', to: '2026-09-02', models: [], projects: [] }, '2026-09-11')).toThrow(QueryError);
  });
});

describe('resolveBucket', () => {
  it('chooses hour for short ranges and day otherwise', () => {
    expect(resolveBucket(undefined, 1)).toBe('hour');
    expect(resolveBucket(undefined, 2)).toBe('hour');
    expect(resolveBucket(undefined, 3)).toBe('day');
    expect(resolveBucket('day', 1)).toBe('day');
    expect(resolveBucket('hour', 7)).toBe('hour');
  });

  it('rejects hourly buckets for long ranges', () => {
    expect(() => resolveBucket('hour', 8)).toThrow(QueryError);
  });
});
