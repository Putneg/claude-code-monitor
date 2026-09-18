import { expect, test } from '@playwright/test';
import type { FiltersResponse, SessionsResponse } from '../../src/shared/api.js';
import { formatTokens } from '../../src/web/lib/format.js';
import { CODEX_TOKENS } from './fixture-codex.js';
import { E2E_QUERY, HAIKU, OPUS, SONNET, totalTokens } from './fixture.js';
import { NO_SIDE_SCROLL, SCREENS, trackConsole, waitForData } from './support.js';

const RANGE = `/?${E2E_QUERY}`;
const CLAUDE_TOKENS = totalTokens([OPUS, SONNET, HAIKU]);

test.beforeEach(async ({ page }) => {
  await waitForData(page);
});

test('switches between clients and filters the totals', async ({ page }) => {
  const problems = trackConsole(page);
  await page.goto(`${RANGE}&unit=tok`);
  const hero = page.getByTestId('hero-main');
  await expect(hero).toHaveText(formatTokens(CLAUDE_TOKENS + CODEX_TOKENS));
  const group = page.getByRole('group', { name: 'client' });
  await group.getByRole('button', { name: 'codex', exact: true }).click();
  await expect(page).toHaveURL(/clients=codex/);
  await expect(hero).toHaveText(formatTokens(CODEX_TOKENS));
  await expect(group.getByRole('button', { name: 'codex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await group.getByRole('button', { name: 'claude', exact: true }).click();
  await expect(hero).toHaveText(formatTokens(CLAUDE_TOKENS));
  await group.getByRole('button', { name: 'all', exact: true }).click();
  await expect(page).not.toHaveURL(/clients=/);
  await expect(hero).toHaveText(formatTokens(CLAUDE_TOKENS + CODEX_TOKENS));
  expect(problems).toEqual([]);
});

test('splits the hero and the timeline by client', async ({ page }) => {
  await page.goto(RANGE);
  const hero = page.getByTestId('spend-hero');
  await expect(hero).toContainText('clients');
  await expect(hero).toContainText(/claude code \$[\d,.]+/);
  await expect(hero).toContainText(/codex \$[\d,.]+/);
  const timeline = page.getByTestId('timeline');
  await timeline.getByRole('button', { name: 'client', exact: true }).click();
  await expect(page).toHaveURL(/stack=client/);
  await expect(timeline).toContainText('claude code');
  await expect(timeline).toContainText('codex');
});

test('shows the latest Codex rate-limit reading', async ({ page }) => {
  const problems = trackConsole(page);
  await page.goto(RANGE);
  const widget = page.getByRole('group', { name: 'codex limits · plus' });
  await expect(widget).toBeVisible();
  await expect(widget).toContainText('as of 10:00');
  await expect(widget).toContainText('weekly');
  await expect(widget).toContainText('42%');
  await expect(widget).toContainText('resets 03-18 09:00');
  await expect(widget).toContainText('5h');
  await expect(widget).toContainText('reset · no newer data');
  await page.screenshot({ path: `${SCREENS}/codex.png`, fullPage: true });
  // No stale window's text is cut off.
  const STALE_FITS =
    "(() => { const all = [...document.querySelectorAll('[data-testid=rate-limits] .wide')]; return all.length > 0 && all.every((el) => el.scrollWidth <= el.clientWidth); })()";
  expect(await page.evaluate(STALE_FITS)).toBe(true);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(RANGE);
  await expect(widget).toBeVisible();
  expect(await page.evaluate(NO_SIDE_SCROLL)).toBe(true);
  expect(await page.evaluate(STALE_FITS)).toBe(true);
  await page.screenshot({ path: `${SCREENS}/codex-320.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('shows the Claude limits above the Codex limits', async ({ page }) => {
  const problems = trackConsole(page);
  await page.goto(RANGE);
  const widget = page.getByRole('group', { name: 'claude limits' });
  await expect(widget).toBeVisible();
  await expect(widget).toContainText('as of 10:00');
  await expect(widget).toContainText('5h');
  await expect(widget).toContainText('23%');
  await expect(widget).toContainText('resets 14:00');
  await expect(widget).toContainText('weekly');
  await expect(widget).toContainText('42%');
  await expect(widget).toContainText('resets 03-18 12:00');
  await expect(widget).toContainText('spend');
  await expect(widget).toContainText('reset · no newer data');
  const titles = await page
    .getByTestId('rate-limits')
    .getByRole('group')
    .evaluateAll((groups) => groups.map((group) => group.getAttribute('aria-label')));
  expect(titles).toEqual(['claude limits', 'codex limits · plus']);
  await page.screenshot({ path: `${SCREENS}/limits.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('tags the Codex session and counts its subagent share', async ({ page }) => {
  await page.goto(RANGE);
  const table = page.getByTestId('sessions-table');
  await expect(table).toContainText('4 in range');
  const row = table.locator('tbody tr', { hasText: 'dev/gamma' });
  await expect(row).toHaveCount(1);
  await expect(row.getByTitle('codex', { exact: true })).toHaveText('cx');
  await expect(row.locator('td').nth(7)).toHaveText(/^\d+%$/);
});

test('counts nothing from the imported session and shows no warnings', async ({ page }) => {
  const sessions = (await (await page.request.get(`/api/sessions?${E2E_QUERY}`)).json()) as SessionsResponse;
  expect(sessions.sessions.map((session) => session.id)).not.toContain('cx-e2e-imported');
  const filters = (await (await page.request.get('/api/filters')).json()) as FiltersResponse;
  expect(filters.clients.map((client) => client.id)).toEqual(['claude', 'codex']);
  await page.goto(RANGE);
  await expect(page.getByTestId('status-bar')).toContainText('● live');
  await expect(page.getByTestId('status-bar')).not.toContainText('⚠');
});
