import { describe, expect, it } from 'vitest';
import { createNotices } from '../../src/server/ingest/notices.js';

describe('createNotices', () => {
  it('reports a key once until it is cleared', () => {
    const notices = createNotices();
    expect(notices.firstTime('source:/a')).toBe(true);
    expect(notices.firstTime('source:/a')).toBe(false);
    expect(notices.firstTime('source:/b')).toBe(true);
    expect(notices.clear('source:/a')).toBe(true);
    expect(notices.clear('source:/a')).toBe(false);
    expect(notices.firstTime('source:/a')).toBe(true);
  });

  it('keeps separate instances apart', () => {
    const first = createNotices();
    const second = createNotices();
    first.firstTime('k');
    expect(second.firstTime('k')).toBe(true);
  });
});
