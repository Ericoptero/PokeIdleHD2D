/**
 * The encounter feed card (`src/ui/dom/feed.js`, Stage 3b) — driven by a real hunt's first
 * real encounter, not a staged one (the showcase's own `battle` mode calls `battle.resolve()`
 * directly and never touches `encounter`, so it emits none of the events this card reads —
 * see that file's own header).
 */
import { test, expect } from '@playwright/test';
import {
  installEventLog, boot, call, stepUntil,
} from './harness.js';

const paintNow = (page) => call(page, 'ui', '_frame', 0.25);
const feedText = (page, cls) => page.locator(`[data-ui="hud-feed"] .${cls}`).innerText();

test('a real encounter resolving populates the feed card with its own outcome', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await call(page, 'travel', 'go', 'hunt-meadow');
  await page.waitForFunction(() => window.__CTX__.get('travel').current()?.id === 'hunt-meadow',
    null, { timeout: 30_000, polling: 100 });

  const { hit } = await stepUntil(page, 'encounter:resolved', { chunk: 10, maxTicks: 8000 });
  await paintNow(page);

  const card = page.locator('[data-ui="hud-feed"]');
  await expect(card).toBeVisible();
  const title = await feedText(page, 'ci-feed-card__title');
  if (hit.payload.caught) expect(title).toMatch(/caught!$/);
  else if (hit.payload.outcome === 'win') expect(title).toMatch(/defeated$/);
  else expect(title).toMatch(/got away$/);

  if (hit.payload.rewards?.exp > 0) {
    const chips = await page.locator('[data-ui="hud-feed"] .ci-feed-chip').allInnerTexts();
    expect(chips.some((c) => c.includes('xp'))).toBe(true);
  }

  expect(errors, 'no console error rendering a real resolved encounter').toEqual([]);
});

test('the feed card is not part of another module\'s showcase chrome', async ({ page }) => {
  const errors = await boot(page, { showcase: 'hunts', mode: 'meadow' });
  await paintNow(page);

  await expect(page.locator('[data-ui="hud-feed"]')).toBeHidden();
  expect(errors, 'no console error booting a passenger showcase with the feed card mounted').toEqual([]);
});
