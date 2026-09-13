import type { PriceEntry, PriceTable } from '../pricing/types.js';
import type { Db } from './connection.js';

export type StoredPriceSource = 'litellm' | 'snapshot';

export interface PriceSourceInfo {
  readonly source: StoredPriceSource;
  readonly fetchedAt: number;
}

export interface ModelMapping {
  readonly model: string;
  readonly priceKey: string | null;
}

export interface RegisteredModel {
  readonly model: string;
  readonly priced: boolean;
}

export interface PriceRepo {
  /** One transaction: deletes every price, inserts `prices`, then upserts `mappings` (resolved_at = fetchedAt). */
  replaceAll(prices: PriceTable, source: StoredPriceSource, fetchedAt: number, mappings?: readonly ModelMapping[]): void;
  /** The stored price table. */
  all(): PriceTable;
  keys(): string[];
  count(): number;
  sourceInfo(): PriceSourceInfo | null;
  mappedModels(): ReadonlySet<string>;
  setMappings(mappings: readonly ModelMapping[], resolvedAt: number): void;
  allModels(): RegisteredModel[];
  unpricedModels(): string[];
}

interface PriceRow {
  readonly price_key: string;
  readonly input: number;
  readonly output: number;
  readonly cache_write_5m: number;
  readonly cache_write_1h: number;
  readonly cache_read: number;
  readonly fast_multiplier: number;
}

const INSERT_PRICE_SQL = `
INSERT INTO prices (price_key, input, output, cache_write_5m, cache_write_1h, cache_read, fast_multiplier, source, fetched_at)
VALUES (@key, @input, @output, @cacheWrite5m, @cacheWrite1h, @cacheRead, @fastMultiplier, @source, @fetchedAt)`;

const ALL_PRICES_SQL = `
SELECT price_key, input, output, cache_write_5m, cache_write_1h, cache_read, fast_multiplier FROM prices ORDER BY price_key`;

const UPSERT_MAPPING_SQL = `
INSERT INTO model_price_map (model, price_key, resolved_at) VALUES (@model, @priceKey, @resolvedAt)
ON CONFLICT (model) DO UPDATE SET price_key = excluded.price_key, resolved_at = excluded.resolved_at`;

const REGISTRY_SQL = `
SELECT m.model AS model, CASE WHEN p.price_key IS NULL THEN 0 ELSE 1 END AS priced
FROM model_price_map m LEFT JOIN prices p ON p.price_key = m.price_key
ORDER BY m.model`;

const toPriceEntry = (row: PriceRow): PriceEntry => ({
  input: row.input,
  output: row.output,
  cacheWrite5m: row.cache_write_5m,
  cacheWrite1h: row.cache_write_1h,
  cacheRead: row.cache_read,
  fastMultiplier: row.fast_multiplier,
});

export function createPriceRepo(db: Db): PriceRepo {
  const deleteAll = db.prepare('DELETE FROM prices');
  const insertPrice = db.prepare(INSERT_PRICE_SQL);
  const allStmt = db.prepare<[], PriceRow>(ALL_PRICES_SQL);
  const keysStmt = db.prepare('SELECT price_key FROM prices ORDER BY price_key');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM prices');
  const sourceStmt = db.prepare('SELECT source, fetched_at FROM prices LIMIT 1');
  const mappedStmt = db.prepare('SELECT model FROM model_price_map');
  const upsertMapping = db.prepare(UPSERT_MAPPING_SQL);
  const registryStmt = db.prepare(REGISTRY_SQL);

  const upsertMappings = (mappings: readonly ModelMapping[], resolvedAt: number): void => {
    mappings.forEach((m) => upsertMapping.run({ model: m.model, priceKey: m.priceKey, resolvedAt }));
  };
  const replaceTx = db.transaction(
    (prices: PriceTable, source: StoredPriceSource, fetchedAt: number, mappings: readonly ModelMapping[]) => {
      deleteAll.run();
      Object.entries(prices).forEach(([key, entry]) => insertPrice.run({ key, ...entry, source, fetchedAt }));
      upsertMappings(mappings, fetchedAt);
    },
  );
  const mappingTx = db.transaction(upsertMappings);
  const registry = (): RegisteredModel[] =>
    (registryStmt.all() as { model: string; priced: number }[]).map((r) => ({
      model: r.model,
      priced: r.priced === 1,
    }));

  return {
    replaceAll: (prices, source, fetchedAt, mappings = []) => replaceTx(prices, source, fetchedAt, mappings),
    all: () => Object.fromEntries(allStmt.all().map((row) => [row.price_key, toPriceEntry(row)])),
    keys: () => (keysStmt.all() as { price_key: string }[]).map((r) => r.price_key),
    count: () => (countStmt.get() as { n: number }).n,
    sourceInfo: () => {
      const row = sourceStmt.get() as { source: StoredPriceSource; fetched_at: number } | undefined;
      return row ? { source: row.source, fetchedAt: row.fetched_at } : null;
    },
    mappedModels: () => new Set((mappedStmt.all() as { model: string }[]).map((r) => r.model)),
    setMappings: (mappings, resolvedAt) => mappingTx(mappings, resolvedAt),
    allModels: registry,
    unpricedModels: () =>
      registry()
        .filter((m) => !m.priced)
        .map((m) => m.model),
  };
}
