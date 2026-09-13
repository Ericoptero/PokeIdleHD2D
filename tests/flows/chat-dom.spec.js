/**
 * The chat mockup (`src/ui/dom/chat.js`, Stage 3c) — a UI mockup for a future multiplayer
 * chat this single-player game does not have yet (see that file's own header for exactly what
 * is real and what is placeholder). This covers the real, wired half: the Enter binding, the
 * editable-target guard that keeps typing from firing game shortcuts, tab switching, and the
 * local echo + `ui:said` seam.
 */
import { test, expect } from '@playwright/test';
import {
  installEventLog, boot, events, key, call,
} from './harness.js';

const paintNow = (page) => call(page, 'ui', '_frame', 0);
const isHidden = (page, tag) => page.locator(`[data-ui="${tag}"]`).isHidden();

test('Enter opens the chat panel and hides the pill; Enter again on an empty box closes it', async ({ page }) => {
  const errors = await boot(page);
  expect(await isHidden(page, 'chat-panel')).toBe(true);
  expect(await isHidden(page, 'chat-pill')).toBe(false);

  await key(page, 'Enter');
  expect(await isHidden(page, 'chat-panel')).toBe(false);
  expect(await isHidden(page, 'chat-pill')).toBe(true);

  // The box is focused and empty — the global Enter never reaches input.js at all (the
  // editable-target guard steps aside for it), so this exercises the input's own local
  // Enter handler, which closes on an empty box exactly like the design's own hint.
  await page.locator('[data-ui="chat-input"]').press('Enter');
  expect(await isHidden(page, 'chat-panel')).toBe(true);
  expect(await isHidden(page, 'chat-pill')).toBe(false);

  expect(errors, 'no console error opening and closing the chat mockup').toEqual([]);
});

test('typing does not fire game shortcuts — the letters of "travel" would otherwise open Travel', async ({ page }) => {
  const errors = await boot(page);
  await key(page, 'Enter');
  await page.locator('[data-ui="chat-input"]').type('travel');

  expect(await call(page, 'ui', 'openPanel')).toBeNull();
  expect(await page.locator('[data-ui="chat-input"]').inputValue()).toBe('travel');
  expect(errors, 'no console error typing game-shortcut letters into chat').toEqual([]);
});

test('sending a message echoes it locally as "You" and emits the ui:said seam', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await key(page, 'Enter');
  await page.locator('[data-ui="chat-input"]').fill('heading to the cave');
  await page.locator('[data-ui="chat-input"]').press('Enter');

  const lines = await page.locator('[data-ui="chat-messages"] .ci-chat-line').allInnerTexts();
  expect(lines.some((l) => l.includes('You:') && l.includes('heading to the cave'))).toBe(true);
  expect(await page.locator('[data-ui="chat-input"]').inputValue()).toBe('');

  const said = (await events(page)).find((e) => e.type === 'ui:said');
  expect(said?.payload).toEqual({ tab: 'world', text: 'heading to the cave' });
  expect(errors, 'no console error sending a chat line').toEqual([]);
});

test('switching tabs shows that tab\'s own messages', async ({ page }) => {
  const errors = await boot(page);
  await key(page, 'Enter');
  await page.click('[data-ui="chat-tab-help"]');
  await paintNow(page);

  const lines = await page.locator('[data-ui="chat-messages"] .ci-chat-line').allInnerTexts();
  expect(lines.some((l) => l.startsWith('Tip:'))).toBe(true);
  expect(errors, 'no console error switching chat tabs').toEqual([]);
});

test('Escape while typing closes the panel without touching the game menu', async ({ page }) => {
  const errors = await boot(page);
  await key(page, 'Enter');
  await page.locator('[data-ui="chat-input"]').press('Escape');

  expect(await isHidden(page, 'chat-panel')).toBe(true);
  expect(await call(page, 'ui', 'openPanel')).toBeNull();
  expect(errors, 'no console error dismissing chat with Escape').toEqual([]);
});

test('the chat mockup is not part of another module\'s showcase chrome', async ({ page }) => {
  const errors = await boot(page, { showcase: 'hunts', mode: 'meadow' });
  await paintNow(page);

  expect(await isHidden(page, 'chat')).toBe(true);
  expect(errors, 'no console error booting a passenger showcase with chat mounted').toEqual([]);
});
