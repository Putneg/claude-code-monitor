import { describe, expect, it } from 'vitest';
import { dataRequest } from '../../../src/web/lib/request.js';
import { DEFAULT_VIEW } from '../../../src/web/lib/view-state.js';

describe('dataRequest', () => {
  const range = { from: '2026-03-01', to: '2026-03-14' };

  it('builds the overview and sessions queries from the view', () => {
    const request = dataRequest({ ...DEFAULT_VIEW, models: ['claude-opus-5'], projects: ['a b'], stack: 'type', sort: 'recent' }, range);
    expect(request.overview).toBe('from=2026-03-01&to=2026-03-14&models=claude-opus-5&projects=a%20b&stack=type');
    expect(request.sessions).toBe('from=2026-03-01&to=2026-03-14&models=claude-opus-5&projects=a%20b&sort=recent&limit=50');
  });

  it('sends an allowed bucket and drops hour on long ranges', () => {
    expect(dataRequest({ ...DEFAULT_VIEW, bucket: 'hour' }, { from: '2026-03-01', to: '2026-03-02' }).overview).toContain('bucket=hour');
    expect(dataRequest({ ...DEFAULT_VIEW, bucket: 'hour' }, range).overview).not.toContain('bucket=');
  });

  it('keeps the key stable when only unit or cumulative change', () => {
    const base = dataRequest(DEFAULT_VIEW, range);
    expect(dataRequest({ ...DEFAULT_VIEW, unit: 'tok', cumulative: false }, range).key).toBe(base.key);
    expect(dataRequest({ ...DEFAULT_VIEW, sort: 'recent' }, range).key).not.toBe(base.key);
  });
});
