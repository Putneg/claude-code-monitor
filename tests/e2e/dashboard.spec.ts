import { expect, test, type Page } from '@playwright/test';
import { DATE_APPLY_DELAY_MS } from '../../src/web/lib/date-input.js';
import { formatTokens } from '../../src/web/lib/format.js';
import { POLL_INTERVAL_MS } from '../../src/web/lib/poll.js';
import { BETA_TOKENS, E2E_FROM, E2E_QUERY, E2E_TO, E2E_TODAY, HAIKU, OPUS, SONNET, totalTokens } from './fixture.js';
import { NO_SIDE_SCROLL, SCREENS, trackConsole, waitForData } from './support.js';

test.beforeEach(async ({ page }) => {
  await waitForData(page);
});

test('serves the dashboard shell with strict headers', async ({ page }) => {
  const problems = trackConsole(page);
  const response = await page.goto(`/?${E2E_QUERY}`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(response?.headers()['content-security-policy']).toContain("form-action 'none'");
  await expect(page).toHaveTitle('claude-code-monitor');
  await expect(page.getByTestId('status-bar')).toContainText('claude-code-monitor');
  await expect(page.getByTestId('status-bar')).toContainText('tz UTC');
  await page.screenshot({ path: `${SCREENS}/shell.png`, fullPage: true });
  expect(problems).toEqual([]);
});

const RANGE = `/?${E2E_QUERY}`;
const ALL_MODELS = [OPUS, SONNET, HAIKU];

test('shows totals for the fixture range', async ({ page }) => {
  const problems = trackConsole(page);
  await page.goto(`${RANGE}&unit=tok`);
  await expect(page.getByTestId('hero-main')).toHaveText(formatTokens(totalTokens(ALL_MODELS)));
  await expect(page.getByTestId('spend-hero')).toContainText('3 in 2 projects');
  await expect(page.getByTestId('status-bar')).toContainText('● live');
  await page.screenshot({ path: `${SCREENS}/hero.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('model toggle changes the totals and the URL', async ({ page }) => {
  await page.goto(`${RANGE}&unit=tok`);
  const hero = page.getByTestId('hero-main');
  await expect(hero).toHaveText(formatTokens(totalTokens(ALL_MODELS)));
  await page.getByRole('checkbox', { name: /haiku-4\.5/ }).click();
  await expect(hero).toHaveText(formatTokens(totalTokens([OPUS, SONNET])));
  await expect(page).toHaveURL(new RegExp(`models=${OPUS},${SONNET}`));
});

test('restores the view from the URL after a reload', async ({ page }) => {
  await page.goto(`${RANGE}&unit=tok&models=${OPUS}`);
  await page.reload();
  await expect(page.getByTestId('hero-main')).toHaveText(formatTokens(totalTokens([OPUS])));
  await expect(page.getByRole('button', { name: 'tok', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('checkbox', { name: /sonnet-5/ })).toHaveAttribute('aria-checked', 'false');
});

test('switches between dollars and tokens', async ({ page }) => {
  await page.goto(RANGE);
  const hero = page.getByTestId('hero-main');
  await expect(hero).toHaveText(/^\$\d/);
  await page.getByRole('button', { name: 'tok', exact: true }).click();
  await expect(hero).toHaveText(formatTokens(totalTokens(ALL_MODELS)));
  await expect(page).toHaveURL(/unit=tok/);
  await expect(page.getByTestId('spend-hero')).toContainText('tokens ·');
});

test('a period change through the date inputs and presets changes the totals', async ({ page }) => {
  const problems = trackConsole(page);
  await page.goto(`${RANGE}&unit=tok`);
  const hero = page.getByTestId('hero-main');
  await expect(hero).toHaveText(formatTokens(totalTokens(ALL_MODELS)));

  // From 03-10 on, only s2 (beta) and s3 (the only haiku usage) are in range.
  const from = page.getByLabel('from', { exact: true });
  const lateTokens = formatTokens(BETA_TOKENS + totalTokens([HAIKU]));
  await from.fill('2026-03-10');
  await expect(page).toHaveURL(/from=2026-03-10/);
  await expect(hero).toHaveText(lateTokens);

  // A cleared date is rejected: once the field loses focus it shows the effective range again, and the totals stay.
  await from.fill('');
  await from.blur();
  await expect(from).toHaveValue('2026-03-10');
  await expect(hero).toHaveText(lateTokens);

  // "all" runs from the first usage day (e2e-m1 on 03-02) to the E2E server's frozen today: 14 days.
  await page.getByRole('button', { name: 'all', exact: true }).click();
  await expect(page).toHaveURL(/range=all/);
  await expect(page.getByLabel('to', { exact: true })).toHaveValue(E2E_TODAY);
  await expect(from).toHaveValue('2026-03-02');
  await expect(page.getByTestId('spend-hero')).toContainText('tokens · all');
  await expect(page.getByTestId('spend-hero')).toContainText('vs prev 14d');
  await expect(hero).toHaveText(formatTokens(totalTokens(ALL_MODELS)));

  // "7d" is the seven days up to the frozen today, 03-09 to 03-15: the same 03-10 and 03-12 usage as from 03-10 on.
  await page.getByRole('button', { name: '7d', exact: true }).click();
  await expect(page).toHaveURL(/range=7d/);
  await expect(from).toHaveValue('2026-03-09');
  await expect(page.getByLabel('to', { exact: true })).toHaveValue(E2E_TODAY);
  await expect(hero).toHaveText(lateTokens);
  expect(problems).toEqual([]);
});

test('filters projects through the searchable picker', async ({ page }) => {
  await page.goto(`${RANGE}&unit=tok`);
  await page.getByRole('button', { name: /all \(2\)/ }).click();
  await page.getByRole('searchbox', { name: 'search projects' }).fill('beta');
  await page.getByRole('checkbox', { name: /dev\/beta/ }).click();
  await expect(page).toHaveURL(/projects=/);
  await expect(page.getByTestId('hero-main')).toHaveText(formatTokens(BETA_TOKENS));
});

test('explains a range without usage', async ({ page }) => {
  // The E2E server's calendar is frozen at E2E_TODAY, the day after the fixture, which has no usage.
  await page.goto('/?range=today');
  await expect(page.getByTestId('empty-state')).toContainText('no usage in range');
  await expect(page.getByTestId('empty-state')).toContainText(`${E2E_TODAY} → ${E2E_TODAY}`);
  await expect(page.getByRole('button', { name: 'today', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('draws the timeline, switches the stack and toggles the cumulative line', async ({ page }) => {
  const problems = trackConsole(page);
  await page.goto(RANGE);
  const timeline = page.getByTestId('timeline');
  await expect(timeline.locator('canvas').first()).toBeVisible();
  await timeline.getByRole('button', { name: 'type', exact: true }).click();
  await expect(page).toHaveURL(/stack=type/);
  await expect(timeline).toContainText('cache read');
  await timeline.getByRole('checkbox', { name: /cumulative/ }).click();
  await expect(page).toHaveURL(/cum=0/);
  await expect(page.getByTestId('token-types')).toContainText('cache reads =');
  await page.screenshot({ path: `${SCREENS}/timeline.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('disables hour buckets for ranges longer than a week', async ({ page }) => {
  const hour = page.getByTestId('timeline').getByRole('button', { name: 'hour', exact: true });
  await page.goto(RANGE);
  await expect(hour).toBeDisabled();
  await expect(hour).toHaveAccessibleDescription('hour buckets need a range of 7 days or less');
  // 03-01 to 03-07 is exactly 7 days (allowed) and has usage, so the timeline renders.
  await page.goto(`/?from=${E2E_FROM}&to=2026-03-07`);
  await expect(hour).toBeEnabled();
});

test('narrows the range by dragging across the timeline', async ({ page }) => {
  await page.goto(RANGE);
  const chart = page.getByTestId('timeline').getByRole('img', { name: /^usage over time/ });
  await expect(chart).toHaveAccessibleName(/^usage over time, 03-01 to 03-14, 14 day buckets, total \$[\d,.]+, peak 03-\d\d \$/);
  await expect(chart.locator('canvas').first()).toBeVisible();
  const box = await chart.boundingBox();
  if (box === null) throw new Error('the timeline chart has no layout box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.35, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, y, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => new URL(page.url()).searchParams.get('from')).not.toBe(E2E_FROM);
  const params = new URL(page.url()).searchParams;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '9999-12-31';
  expect(from > E2E_FROM).toBe(true);
  expect(to < E2E_TO).toBe(true);
  // The hero reloads for the brushed range: its range label and "vs prev Nd" come from the new overview.
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const hero = page.getByTestId('spend-hero');
  await expect(hero).toContainText(`${from.slice(5)} → ${to.slice(5)}`);
  await expect(hero).toContainText(`vs prev ${days}d`);
});

test('lists every model in range with its cost per million tokens', async ({ page }) => {
  await page.goto(RANGE);
  const table = page.getByTestId('models-table');
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table).toContainText('opus-5');
  await expect(table).toContainText('haiku-4.5');
  // The first row is opus-5 (priced), so its $/Mtok cell is a dollar amount, not a dash.
  await expect(table.locator('tbody tr').first().locator('td').last()).toHaveText(/^\$\d+\.\d{2}$/);
});

test('clicking a project row adds it to the filter', async ({ page }) => {
  await page.goto(RANGE);
  await page
    .getByTestId('projects-table')
    .getByRole('button', { name: /dev\/beta/ })
    .click();
  await expect(page).toHaveURL(/projects=/);
  await expect(page.getByTestId('spend-hero')).toContainText('1 in 1 project');
  await expect(page.getByRole('button', { name: /1 selected/ })).toBeVisible();
});

test('lists sessions with titles, placeholders and sorting', async ({ page }) => {
  const problems = trackConsole(page);
  await page.goto(RANGE);
  const table = page.getByTestId('sessions-table');
  await expect(table).toContainText('Refactor the transcript parser');
  await expect(table).toContainText('(untitled)');
  await expect(table).toContainText('3 in range');
  await table.getByRole('button', { name: 'recent', exact: true }).click();
  await expect(page).toHaveURL(/sort=recent/);
  await expect(table.locator('tbody tr').first()).toContainText('(untitled)');
  await page.screenshot({ path: `${SCREENS}/dashboard.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('holds a reversed date until the field is left, and applies a typed date on Enter', async ({ page }) => {
  const problems = trackConsole(page);
  // The clock runs in real time while the page loads; once paused, timers fire only when the test moves it.
  await page.clock.install();
  await page.goto(`/?from=2026-03-10&to=${E2E_TO}&unit=tok`);
  await expect(page.getByTestId('hero-main')).toHaveText(formatTokens(BETA_TOKENS + totalTokens([HAIKU])));
  await page.clock.pauseAt(Date.now() + 5_000);
  const loadedUrl = page.url();
  const from = page.getByLabel('from', { exact: true });
  const to = page.getByLabel('to', { exact: true });

  // 03-05 is before from: ordering the pair would rewrite the field being typed in, so the day waits for blur or Enter.
  await to.fill('2026-03-05');
  await page.clock.runFor(DATE_APPLY_DELAY_MS * 2);
  expect(page.url()).toBe(loadedUrl);
  await expect(to).toHaveValue('2026-03-05');

  // A status poll re-derives the range with the same days, which must not drop the held day. The poller asks again
  // only after a poll has been applied, so a second request proves that the first one landed.
  const statusRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/status') statusRequests.push(request.url());
  });
  await expect
    .poll(async () => {
      await page.clock.fastForward(POLL_INTERVAL_MS);
      return statusRequests.length;
    })
    .toBeGreaterThanOrEqual(2);

  await to.blur();
  await expect(page).toHaveURL(/from=2026-03-05&to=2026-03-10/);
  await expect(from).toHaveValue('2026-03-05');
  await expect(to).toHaveValue('2026-03-10');

  // The paused clock never ends the pause in typing, so only Enter can apply this day; the focus stays in the field.
  await to.fill('2026-03-12');
  await to.press('Enter');
  await expect(page).toHaveURL(/from=2026-03-05&to=2026-03-12/);
  await expect(to).toBeFocused();
  expect(problems).toEqual([]);
});

/**
 * Chromium orders the fields of a date input by the OS short-date format on Windows (day first on many systems, even
 * with locale en-US) and by the browser locale elsewhere, so the year is not always the third field. A throwaway page
 * in the same browser finds it: ArrowUp changes the focused field, and the year field is the one that turns 2026 into
 * 2027. Returns how many ArrowRight presses lead from the first field (where focus() lands) to the year.
 */
async function yearFieldOffset(page: Page): Promise<number> {
  const probe = await page.context().newPage();
  try {
    await probe.setContent('<input type="date" aria-label="probe" value="2026-03-01">');
    const input = probe.getByLabel('probe');
    await input.focus();
    for (let offset = 0; offset < 3; offset += 1) {
      await probe.keyboard.press('ArrowUp');
      if ((await input.inputValue()).startsWith('2027-')) return offset;
      await probe.keyboard.press('ArrowRight');
    }
    throw new Error('ArrowUp changed no year field in the date input');
  } finally {
    await probe.close();
  }
}

test('typing a year digit by digit applies the date once, after the last digit', async ({ page }) => {
  const problems = trackConsole(page);
  // The range starts in 2025, so typing 2026 into the from year passes through 0002, 0020 and 0202 first.
  await page.goto(`/?from=2025-03-10&to=${E2E_TO}&unit=tok`);
  const hero = page.getByTestId('hero-main');
  await expect(hero).toHaveText(formatTokens(totalTokens(ALL_MODELS)));
  const offset = await yearFieldOffset(page);

  const overviewRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/overview') overviewRequests.push(request.url());
  });
  const from = page.getByLabel('from', { exact: true });
  await from.focus();
  for (let step = 0; step < offset; step += 1) await page.keyboard.press('ArrowRight');
  await from.pressSequentially('2026');

  // From 03-10 on, only s2 (beta) and s3 (the only haiku usage) are in range.
  await expect(page).toHaveURL(/from=2026-03-10/);
  await expect(hero).toHaveText(formatTokens(BETA_TOKENS + totalTokens([HAIKU])));
  expect(overviewRequests).toHaveLength(1);
  expect(problems).toEqual([]);
});

test('fills wide screens and keeps narrow ones from scrolling sideways', async ({ page }) => {
  const problems = trackConsole(page);
  const timeline = page.getByTestId('timeline');
  const chart = timeline.getByRole('img', { name: /^usage over time/ });
  for (const width of [2560, 1920]) {
    await page.setViewportSize({ width, height: 1300 });
    await page.goto(RANGE);
    await expect(chart.locator('canvas').first()).toBeVisible();
    // With the old 1280px page the timeline took under half of a 1920px screen.
    expect((await timeline.boundingBox())?.width ?? 0).toBeGreaterThan(width * 0.75);
    // clamp(260px, 18vw, 400px): 400px at 2560, 345.6px at 1920.
    expect((await chart.boundingBox())?.height ?? 0).toBeCloseTo(Math.min(400, width * 0.18), 0);
    expect(await page.evaluate(NO_SIDE_SCROLL)).toBe(true);
    await page.screenshot({ path: `${SCREENS}/wide-${width}.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(RANGE);
  await expect(chart.locator('canvas').first()).toBeVisible();
  expect(await page.evaluate(NO_SIDE_SCROLL)).toBe(true);
  await page.screenshot({ path: `${SCREENS}/narrow-320.png`, fullPage: true });
  // The open project picker stays inside the viewport too.
  await page.getByRole('button', { name: /all \(2\)/ }).click();
  const panel = await page.getByRole('dialog', { name: 'filter projects' }).boundingBox();
  expect(panel?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((panel?.x ?? 0) + (panel?.width ?? 1_000)).toBeLessThanOrEqual(320);
  expect(await page.evaluate(NO_SIDE_SCROLL)).toBe(true);

  // Opened on a wide window, then narrowed (a phone turned upright): the open panel is placed again for the new width.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.getByRole('button', { name: /all \(2\)/ }).click();
  await page.setViewportSize({ width: 400, height: 900 });
  await expect.poll(() => page.evaluate(NO_SIDE_SCROLL)).toBe(true);
  const turned = await page.getByRole('dialog', { name: 'filter projects' }).boundingBox();
  expect(turned?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((turned?.x ?? 0) + (turned?.width ?? 1_000)).toBeLessThanOrEqual(400);
  expect(problems).toEqual([]);
});

test('names its headings and controls, and closes the project picker when focus leaves it', async ({ page }) => {
  await page.goto(RANGE);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('claude-code-monitor');
  // SpendHero, TokenTypes, ModelsTable, ProjectsTable and SessionsTable captions.
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(5);
  await expect(page.getByRole('status')).toHaveText('● live');
  await expect(page.getByRole('button', { name: '$ (dollars)' })).toHaveAttribute('aria-pressed', 'true');

  const toggle = page.getByRole('button', { name: 'projects: all (2)' });
  await toggle.click();
  const panel = page.getByRole('dialog', { name: 'filter projects' });
  await expect(toggle).toHaveAttribute('aria-controls', (await panel.getAttribute('id')) ?? 'missing');
  await expect(page.getByRole('searchbox', { name: 'search projects' })).toBeFocused();
  // Moving focus inside the picker keeps it open; moving it out closes it.
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('checkbox').first()).toBeFocused();
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'tok', exact: true }).focus();
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('shows web search requests in the hero', async ({ page }) => {
  await page.goto(RANGE);
  const hero = page.getByTestId('spend-hero');
  await expect(hero).toContainText('web search');
  await expect(hero).toContainText('$0.02 · 2 requests');
  // The searches are on 03-10, so a range before it has no row.
  await page.goto(`/?from=${E2E_FROM}&to=2026-03-07`);
  await expect(hero).toContainText('03-01 → 03-07');
  await expect(hero).not.toContainText('web search');
});

test('Back undoes a range change', async ({ page }) => {
  await page.goto(RANGE);
  const hero = page.getByTestId('spend-hero');
  await expect(hero).toContainText('spend · 03-01 → 03-14');
  // A range change pushes a history entry ...
  await page.getByRole('button', { name: 'all', exact: true }).click();
  await expect(page).toHaveURL(/range=all/);
  await expect(hero).toContainText('spend · all');
  // ... and any other change replaces it, so one Back returns to the previous range.
  await page.getByRole('button', { name: 'tok', exact: true }).click();
  await expect(page).toHaveURL(/range=all&unit=tok/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`\\?${E2E_QUERY}$`));
  await expect(hero).toContainText('spend · 03-01 → 03-14');
});

test('Back drops a date that was held while typing', async ({ page }) => {
  // The clock runs in real time while the page loads; once paused, timers fire only when the test moves it.
  await page.clock.install();
  await page.goto(`/?from=2026-03-02&to=${E2E_TO}&unit=tok`);
  await expect(page.getByTestId('hero-main')).toHaveText(formatTokens(totalTokens(ALL_MODELS)));
  await page.clock.pauseAt(Date.now() + 5_000);
  const loadedUrl = page.url();
  const from = page.getByLabel('from', { exact: true });
  const to = page.getByLabel('to', { exact: true });

  // Enter applies a typed day at once, and the new range pushes a history entry.
  await from.fill('2026-03-10');
  await from.press('Enter');
  await expect(page).toHaveURL(/from=2026-03-10/);

  // 03-05 is before the new from, so the day is held until the field is left. Back restores the older range while the
  // field still has focus.
  await to.fill('2026-03-05');
  await page.goBack();
  await expect(page).toHaveURL(loadedUrl);
  await expect(to).toBeFocused();

  // Leaving the field must not apply a day that was typed against the range Back replaced.
  await to.blur();
  await expect(from).toHaveValue('2026-03-02');
  await expect(to).toHaveValue(E2E_TO);
  expect(page.url()).toBe(loadedUrl);
});

test('clearing the project selection keeps the picker open and focused', async ({ page }) => {
  await page.goto(RANGE);
  await page.getByRole('button', { name: 'projects: all (2)' }).click();
  const panel = page.getByRole('dialog', { name: 'filter projects' });
  await panel.getByRole('checkbox').first().click();
  const clear = panel.getByRole('button', { name: 'all projects' });
  await clear.click();
  await expect(panel).toBeVisible();
  await expect(clear).toBeFocused();
  await expect(clear).toBeDisabled();
  await expect(page.getByRole('button', { name: 'projects: all (2)' })).toHaveAttribute('aria-expanded', 'true');
  // A blur with no new focus target (a window switch) is not a move out of the picker.
  await clear.blur();
  await expect(panel).toBeVisible();
});

test('shows no client switch or Codex limits without Codex data', async ({ page }) => {
  await page.goto(RANGE);
  await expect(page.getByTestId('spend-hero')).toBeVisible();
  await expect(page.getByRole('group', { name: 'client' })).toHaveCount(0);
  await expect(page.getByTestId('codex-limits')).toHaveCount(0);
  await expect(page.getByTestId('timeline').getByRole('button', { name: 'client', exact: true })).toHaveCount(0);
  // The fixture server points at a Codex home that does not exist: an absent optional source is neither listed nor a warning.
  await expect(page.getByTestId('status-bar')).not.toContainText('codex');
  await expect(page.getByTestId('status-bar')).not.toContainText('⚠');
  await expect(page.getByTestId('spend-hero')).not.toContainText('clients');
});
