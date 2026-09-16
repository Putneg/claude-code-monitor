import { describe, expect, it } from 'vitest';
import { claudeRoot, codexRoot, sourceRoots } from '../../src/server/ingest/sources.js';

describe('sourceRoots', () => {
  it('lists the required Claude roots first, then the optional Codex roots', () => {
    expect(sourceRoots({ projectsDirs: ['/claude/projects'], codexRoots: ['/codex/sessions', '/codex/archived_sessions'] })).toEqual([
      { path: '/claude/projects', client: 'claude', required: true },
      { path: '/codex/sessions', client: 'codex', required: false },
      { path: '/codex/archived_sessions', client: 'codex', required: false },
    ]);
  });

  it('builds single roots', () => {
    expect(claudeRoot('/a')).toEqual({ path: '/a', client: 'claude', required: true });
    expect(codexRoot('/b')).toEqual({ path: '/b', client: 'codex', required: false });
  });
});
