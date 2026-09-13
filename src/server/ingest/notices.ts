/** Problems already logged, so a condition that lasts many scan cycles is reported once instead of every cycle. */
export interface Notices {
  /** True the first time `key` is seen since it was last cleared. */
  firstTime(key: string): boolean;
  /** Forgets `key`; true when it had been seen. */
  clear(key: string): boolean;
}

export function createNotices(): Notices {
  const seen = new Set<string>();
  return {
    firstTime: (key) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    clear: (key) => seen.delete(key),
  };
}
