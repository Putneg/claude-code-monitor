import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { E2E_NOW_MS } from './fixture.js';

const HOUR_MS = 3_600_000;
const sec = (ms: number): number => Math.floor(ms / 1000);

/**
 * The status line tap's file as of 10:00 UTC on the fixture day (the frozen clock says 12:00): a 5h window at 23% that
 * resets at 14:00, a weekly window at 41.6% that resets three days later at 12:00, and a spend window that has reset.
 */
export function writeClaudeLimitsFixture(file: string): void {
  const observed = sec(E2E_NOW_MS - 2 * HOUR_MS);
  const windows = {
    five_hour: { used_percentage: 23, resets_at: sec(E2E_NOW_MS + 2 * HOUR_MS), observed_at: observed },
    seven_day: { used_percentage: 41.6, resets_at: sec(E2E_NOW_MS + 72 * HOUR_MS), observed_at: observed },
    spend_limit: { used_percentage: 130, resets_at: sec(E2E_NOW_MS - HOUR_MS), observed_at: observed },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, windows })}\n`);
}
