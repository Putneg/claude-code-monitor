/** USD per token. */
export interface PriceEntry {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly fastMultiplier: number;
}

export type PriceTable = Readonly<Record<string, PriceEntry>>;

export interface PriceSnapshot {
  readonly fetchedAt: string;
  readonly prices: PriceTable;
}
