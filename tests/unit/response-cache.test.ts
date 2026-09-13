import { describe, expect, it } from 'vitest';
import { createResponseCache } from '../../src/server/http/response-cache.js';

describe('createResponseCache', () => {
  it('returns a stored value and undefined for a missing key', () => {
    const cache = createResponseCache<string>(2);
    cache.set('a', 'alpha');
    expect(cache.get('a')).toBe('alpha');
    expect(cache.get('b')).toBeUndefined();
  });

  it('evicts the least recently stored entry past the limit', () => {
    const cache = createResponseCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size()).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('treats a read as a use, so the entry read last survives the next eviction', () => {
    const cache = createResponseCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('replaces the value of an existing key without growing', () => {
    const cache = createResponseCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    cache.set('c', 3);
    expect(cache.size()).toBe(2);
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects maxEntries %s', (maxEntries) => {
    expect(() => createResponseCache<number>(maxEntries)).toThrow(RangeError);
  });
});
