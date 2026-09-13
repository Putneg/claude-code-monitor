/** A small least-recently-used cache. `undefined` is not a storable value: it means "missing". */
export interface ResponseCache<V> {
  /** The stored value, which also becomes the most recently used entry. */
  get(key: string): V | undefined;
  /** Stores the value as the most recently used entry, evicting the least recently used one past the limit. */
  set(key: string, value: V): void;
  /** Number of stored entries. */
  size(): number;
}

/** Map iteration follows insertion order, so re-inserting on every use keeps the least recently used key first. */
export function createResponseCache<V>(maxEntries: number): ResponseCache<V> {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(`maxEntries must be a positive integer, got ${maxEntries}`);
  }
  const entries = new Map<string, V>();
  return {
    get: (key) => {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set: (key, value) => {
      entries.delete(key);
      entries.set(key, value);
      const oldest = entries.keys().next();
      if (entries.size > maxEntries && !oldest.done) entries.delete(oldest.value);
    },
    size: () => entries.size,
  };
}
