import { expect, type Page } from '@playwright/test';
import type { StatusResponse } from '../../src/shared/api.js';

/** Full-page screenshots for reviewers; Playwright clears test-results/ at the start of each run. */
export const SCREENS = 'test-results/screens';

/** Waits until the first ingest cycle has finished (lastSyncAt is set at the end of a cycle) and stored rows. */
export async function waitForData(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const status = (await (await page.request.get('/api/status')).json()) as StatusResponse;
        return status.sync.lastSyncAt !== null && status.data.rows > 0;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

export function trackConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

/** True when nothing scrolls the page sideways. A string, so the spec typechecks without DOM types. */
export const NO_SIDE_SCROLL = 'document.documentElement.scrollWidth <= document.documentElement.clientWidth';
