import { describe, expect, it } from 'vitest';
import type { PriceTable } from '../../src/server/pricing/types.js';
import { createTestDb } from '../helpers/db.js';

const PRICES: PriceTable = {
  'claude-opus-5': { input: 5e-6, output: 2.5e-5, cacheWrite5m: 6.25e-6, cacheWrite1h: 1e-5, cacheRead: 5e-7, fastMultiplier: 2 },
  'claude-sonnet-5': { input: 2e-6, output: 1e-5, cacheWrite5m: 2.5e-6, cacheWrite1h: 4e-6, cacheRead: 2e-7, fastMultiplier: 1 },
};

describe('file state repo', () => {
  it('upserts, lists, counts and removes file states', () => {
    const { repos } = createTestDb();
    repos.files.upsert({ path: '/a.jsonl', size: 10, mtimeMs: 1.5, offset: 10, fingerprint: null, parserState: null });
    repos.files.upsert({ path: '/b.jsonl', size: 20, mtimeMs: 2.25, offset: 15, fingerprint: null, parserState: '{"v":1}' });
    repos.files.upsert({ path: '/a.jsonl', size: 30, mtimeMs: 3.5, offset: 30, fingerprint: '30:0123456789abcdef', parserState: null });
    expect(repos.files.count()).toBe(2);
    expect(repos.files.all().get('/a.jsonl')).toEqual({
      path: '/a.jsonl',
      size: 30,
      mtimeMs: 3.5,
      offset: 30,
      fingerprint: '30:0123456789abcdef',
      parserState: null,
    });
    expect(repos.files.all().get('/b.jsonl')).toMatchObject({ fingerprint: null, parserState: '{"v":1}' });
    repos.files.remove(['/a.jsonl']);
    repos.files.remove([]);
    expect([...repos.files.all().keys()]).toEqual(['/b.jsonl']);
  });
});

describe('meta repo', () => {
  it('stores string values by key', () => {
    const { repos } = createTestDb();
    expect(repos.meta.get('tz')).toBeNull();
    repos.meta.set('tz', 'Europe/Kyiv');
    repos.meta.set('tz', 'UTC');
    expect(repos.meta.get('tz')).toBe('UTC');
  });
});

/** A table with only the PRICES entry for `key`. */
const only = (key: string): PriceTable => Object.fromEntries(Object.entries(PRICES).filter(([name]) => name === key));

describe('price repo', () => {
  it('replaces the whole price table atomically', () => {
    const { repos } = createTestDb();
    expect(repos.prices.count()).toBe(0);
    expect(repos.prices.sourceInfo()).toBeNull();
    repos.prices.replaceAll(PRICES, 'snapshot', 1_000);
    expect(repos.prices.keys()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    repos.prices.replaceAll({ 'claude-opus-5': PRICES['claude-opus-5']! }, 'litellm', 2_000);
    expect(repos.prices.keys()).toEqual(['claude-opus-5']);
    expect(repos.prices.sourceInfo()).toEqual({ source: 'litellm', fetchedAt: 2_000 });
  });

  it('maintains the model registry', () => {
    const { repos } = createTestDb();
    repos.prices.replaceAll(PRICES, 'snapshot', 1_000);
    repos.prices.setMappings(
      [
        { model: 'claude-opus-5', priceKey: 'claude-opus-5' },
        { model: 'claude-mystery', priceKey: null },
      ],
      5,
    );
    expect([...repos.prices.mappedModels()].sort()).toEqual(['claude-mystery', 'claude-opus-5']);
    expect(repos.prices.allModels()).toEqual([
      { model: 'claude-mystery', priced: false },
      { model: 'claude-opus-5', priced: true },
    ]);
    expect(repos.prices.unpricedModels()).toEqual(['claude-mystery']);
    repos.prices.setMappings([{ model: 'claude-mystery', priceKey: 'claude-sonnet-5' }], 6);
    expect(repos.prices.unpricedModels()).toEqual([]);
  });

  it('treats a mapping to a removed key as unpriced', () => {
    const { repos } = createTestDb();
    repos.prices.replaceAll(PRICES, 'snapshot', 1_000);
    repos.prices.setMappings([{ model: 'claude-sonnet-5', priceKey: 'claude-sonnet-5' }], 5);
    repos.prices.replaceAll({ 'claude-opus-5': PRICES['claude-opus-5']! }, 'litellm', 2_000);
    expect(repos.prices.allModels()).toEqual([{ model: 'claude-sonnet-5', priced: false }]);
    expect(repos.prices.unpricedModels()).toEqual(['claude-sonnet-5']);
  });

  it('returns the stored price table', () => {
    const { repos } = createTestDb();
    expect(repos.prices.all()).toEqual({});
    repos.prices.replaceAll(PRICES, 'snapshot', 1_000);
    expect(repos.prices.all()).toEqual(PRICES);
  });

  it('replaces prices and upserts mappings together, stamping them with fetchedAt', () => {
    const { db, repos } = createTestDb();
    repos.prices.replaceAll(PRICES, 'snapshot', 1_000);
    repos.prices.setMappings([{ model: 'claude-opus-5', priceKey: 'claude-opus-5' }], 5);
    repos.prices.replaceAll(only('claude-sonnet-5'), 'litellm', 2_000, [
      { model: 'claude-opus-5', priceKey: null },
      { model: 'claude-sonnet-5', priceKey: 'claude-sonnet-5' },
    ]);
    expect(repos.prices.allModels()).toEqual([
      { model: 'claude-opus-5', priced: false },
      { model: 'claude-sonnet-5', priced: true },
    ]);
    expect(db.prepare<[], { resolved_at: number }>('SELECT DISTINCT resolved_at FROM model_price_map').all()).toEqual([
      { resolved_at: 2_000 },
    ]);
  });

  it('rolls back the new prices when a mapping cannot be written', () => {
    const { db, repos } = createTestDb();
    repos.prices.replaceAll(PRICES, 'snapshot', 1_000);
    db.exec(`CREATE TRIGGER reject_mapping BEFORE INSERT ON model_price_map WHEN NEW.model = 'claude-rejected'
             BEGIN SELECT RAISE(ABORT, 'mapping rejected'); END`);
    expect(() =>
      repos.prices.replaceAll(only('claude-opus-5'), 'litellm', 2_000, [{ model: 'claude-rejected', priceKey: 'claude-opus-5' }]),
    ).toThrow('mapping rejected');
    expect(repos.prices.keys()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(repos.prices.sourceInfo()).toEqual({ source: 'snapshot', fetchedAt: 1_000 });
  });
});
