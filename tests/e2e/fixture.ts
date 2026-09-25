import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assistantLine, titleLine } from '../helpers/records.js';

/** Days covered by the fixture (UTC). Tests pass them as from/to so assertions never depend on the real date. */
export const E2E_FROM = '2026-03-01';
export const E2E_TO = '2026-03-14';
export const E2E_QUERY = `from=${E2E_FROM}&to=${E2E_TO}`;

/** "Today" for the E2E server, whose calendar clock is frozen here: the day after the fixture, which has no usage. */
export const E2E_TODAY = '2026-03-15';
export const E2E_NOW_MS = Date.parse(`${E2E_TODAY}T12:00:00.000Z`);

export const OPUS = 'claude-opus-5';
export const SONNET = 'claude-sonnet-5';
export const HAIKU = 'claude-haiku-4-5-20251001';

export const ALPHA_PATH = '/home/dev/alpha';
export const BETA_PATH = '/home/dev/beta';

/** Total tokens (input + output + cache read + cache writes) per model in the fixture. */
export const TOKENS_BY_MODEL: Readonly<Record<string, number>> = {
  [OPUS]: 1_083_000,
  [SONNET]: 600_000,
  [HAIKU]: 150_000,
};

/** Tokens of the only beta session (e2e-s2). */
export const BETA_TOKENS = 245_000;

export const totalTokens = (models: readonly string[]): number => models.reduce((sum, model) => sum + (TOKENS_BY_MODEL[model] ?? 0), 0);

const FILES: Readonly<Record<string, readonly string[]>> = {
  '-home-dev-alpha/e2e-s1.jsonl': [
    assistantLine({
      messageId: 'e2e-m1',
      model: OPUS,
      sessionId: 'e2e-s1',
      timestamp: '2026-03-02T10:00:00.000Z',
      cwd: ALPHA_PATH,
      usage: { input: 1_000, output: 20_000, cacheRead: 400_000, cacheWrite5m: 10_000 },
    }),
    assistantLine({
      messageId: 'e2e-m2',
      model: OPUS,
      sessionId: 'e2e-s1',
      timestamp: '2026-03-05T12:00:00.000Z',
      cwd: ALPHA_PATH,
      usage: { input: 2_000, output: 30_000, cacheRead: 600_000, cacheWrite1h: 20_000 },
    }),
    titleLine('e2e-s1', 'Refactor the transcript parser'),
  ],
  '-home-dev-alpha/e2e-s1/subagents/agent-e2e.jsonl': [
    assistantLine({
      messageId: 'e2e-m3',
      model: SONNET,
      sessionId: 'e2e-s1',
      timestamp: '2026-03-05T12:30:00.000Z',
      cwd: ALPHA_PATH,
      isSidechain: true,
      agentId: 'e2e-agent',
      usage: { input: 5_000, output: 50_000, cacheRead: 300_000 },
    }),
  ],
  '-home-dev-beta/e2e-s2.jsonl': [
    assistantLine({
      messageId: 'e2e-m4',
      model: SONNET,
      sessionId: 'e2e-s2',
      timestamp: '2026-03-10T09:00:00.000Z',
      cwd: BETA_PATH,
      // Two web searches ($0.01 each): the hero shows a web search row for ranges that include 03-10.
      usage: { input: 5_000, output: 40_000, cacheRead: 200_000, webSearchRequests: 2 },
    }),
    // A Cyrillic title ("Dashboard tests"), written with escapes: the repository allows no Cyrillic characters.
    titleLine('e2e-s2', '\u0422\u0435\u0441\u0442\u044b \u0434\u0430\u0448\u0431\u043e\u0440\u0434\u0430'),
  ],
  '-home-dev-alpha/e2e-s3.jsonl': [
    assistantLine({
      messageId: 'e2e-m5',
      model: HAIKU,
      sessionId: 'e2e-s3',
      timestamp: '2026-03-12T15:00:00.000Z',
      cwd: ALPHA_PATH,
      usage: { input: 100_000, output: 50_000 },
    }),
  ],
};

export function writeFixture(projectsRoot: string): void {
  for (const [relative, lines] of Object.entries(FILES)) {
    const file = join(projectsRoot, ...relative.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join('\n')}\n`);
  }
}
