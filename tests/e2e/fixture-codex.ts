import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionMetaLine, tokenCountLine, turnContextLine, usageRecordLine } from '../helpers/codex-records.js';

export const CODEX_SOL = 'gpt-5.6-sol';
export const CODEX_ASTRA = 'gpt-6-astra';
export const GAMMA_PATH = '/home/dev/gamma';
/** Tokens of the Codex responses: 50k + 150k + 10k, 20k + 80k + 5k, and the subagent's 10k + 40k + 1k. */
export const CODEX_TOKENS = 366_000;

const seconds = (iso: string): number => Date.parse(iso) / 1_000;

const FILES: Readonly<Record<string, readonly string[]>> = {
  'sessions/2026/03/06/rollout-2026-03-06T10-00-00-cx-e2e-main.jsonl': [
    sessionMetaLine({ id: 'cx-e2e-main', cwd: GAMMA_PATH, timestamp: '2026-03-06T10:00:00.000Z' }),
    turnContextLine({ turnId: 'cx-t1', model: CODEX_SOL, cwd: GAMMA_PATH, timestamp: '2026-03-06T10:00:01.000Z' }),
    usageRecordLine({
      responseId: 'resp_e2e_1',
      threadId: 'cx-e2e-main',
      turnId: 'cx-t1',
      timestamp: '2026-03-06T10:01:00.000Z',
      input: 200_000,
      cached: 150_000,
      output: 10_000,
    }),
    turnContextLine({ turnId: 'cx-t2', model: CODEX_ASTRA, cwd: GAMMA_PATH, timestamp: '2026-03-08T11:00:00.000Z' }),
    usageRecordLine({
      responseId: 'resp_e2e_2',
      threadId: 'cx-e2e-main',
      turnId: 'cx-t2',
      timestamp: '2026-03-08T11:00:30.000Z',
      input: 100_000,
      cached: 80_000,
      output: 5_000,
    }),
    // Read on the E2E server's frozen "today": the 5h window has already reset, the weekly one has not.
    tokenCountLine({
      timestamp: '2026-03-15T10:00:00.000Z',
      totalTokens: 315_000,
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 90, windowMinutes: 300, resetsAt: seconds('2026-03-15T11:00:00.000Z') },
        secondary: { usedPercent: 42, windowMinutes: 10_080, resetsAt: seconds('2026-03-18T09:00:00.000Z') },
      },
    }),
  ],
  'sessions/2026/03/06/rollout-2026-03-06T10-05-00-cx-e2e-sub.jsonl': [
    sessionMetaLine({ id: 'cx-e2e-sub', sessionId: 'cx-e2e-main', subagent: true, cwd: GAMMA_PATH, timestamp: '2026-03-06T10:05:00.000Z' }),
    // Copied from the parent when the subagent starts: a cumulative total that must not count again.
    tokenCountLine({ timestamp: '2026-03-06T10:05:00.000Z', totalTokens: 210_000 }),
    turnContextLine({ turnId: 'cx-s1', model: CODEX_ASTRA, cwd: GAMMA_PATH, timestamp: '2026-03-06T10:05:01.000Z' }),
    usageRecordLine({
      responseId: 'resp_e2e_3',
      threadId: 'cx-e2e-sub',
      sessionId: 'cx-e2e-main',
      turnId: 'cx-s1',
      timestamp: '2026-03-06T10:06:00.000Z',
      input: 50_000,
      cached: 40_000,
      output: 1_000,
    }),
  ],
  // An imported session of another agent: a total without a breakdown and no usage records.
  'archived_sessions/rollout-2026-03-05T09-00-00-cx-e2e-imported.jsonl': [
    sessionMetaLine({ id: 'cx-e2e-imported', cwd: '/home/dev/alpha', timestamp: '2026-03-05T09:00:00.000Z' }),
    tokenCountLine({ timestamp: '2026-03-05T09:00:00.000Z', totalTokens: 999_999 }),
  ],
};

export function writeCodexFixture(codexHome: string): void {
  for (const [relative, lines] of Object.entries(FILES)) {
    const file = join(codexHome, ...relative.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join('\n')}\n`);
  }
}
