/**
 * The Códice "while you were away" card (`src/ui/screens/offline.js`) — the first screen
 * converted off the pixel canvas onto the DOM layer (`src/ui/dom/layer.js`). Driven through
 * the same real-input primitives every canvas panel flow uses (`key()`, and `click()` for the
 * DOM equivalent of a canvas `pointer()` click), so this proves the DOM/canvas coexistence at
 * the input layer, not only in a screenshot.
 */
import { test, expect } from '@playwright/test';
import {
  boot, call, key, click, probe,
} from './harness.js';

const SUMMARY = {
  awayS: 3600, effectiveS: 3200, capped: false, efficiency: 0.89,
  bands: [{ seconds: 3600, avgEfficiency: 0.89 }],
  applied: { money: 420, research: 12 },
  pending: {},
  notes: ['a synthetic summary for the flow test'],
};

test('opening the offline screen mounts the Códice card and registers it with the panel driver', async ({ page }) => {
  const errors = await boot(page);
  await call(page, 'ui', 'open', 'offline', { summary: SUMMARY });

  expect(await call(page, 'ui', 'openPanel')).toBe('offline');
  const tags = (await probe(page)).map((r) => r.tag);
  expect(tags).toContain('offline-scrim');
  expect(tags).toContain('offline-continue');
  expect(tags).toContain('offline-section-What you earned');
  expect(errors, 'no console error opening the offline screen').toEqual([]);
});

test('the Continue button closes it and unmounts the DOM card', async ({ page }) => {
  const errors = await boot(page);
  await call(page, 'ui', 'open', 'offline', { summary: SUMMARY });
  await click(page, 'offline-continue');

  expect(await call(page, 'ui', 'openPanel')).toBeNull();
  expect(await probe(page)).toEqual([]);
  expect(errors, 'no console error closing the offline screen').toEqual([]);
});

test('Enter closes it, same as every canvas panel', async ({ page }) => {
  const errors = await boot(page);
  await call(page, 'ui', 'open', 'offline', { summary: SUMMARY });
  await key(page, 'Enter');

  expect(await call(page, 'ui', 'openPanel')).toBeNull();
  expect(await probe(page)).toEqual([]);
  expect(errors, 'no console error dismissing the offline screen with Enter').toEqual([]);
});
