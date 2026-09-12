/**
 * The game boots at `/`: the first frame is presented, nothing was fatal, no module is down,
 * and the console is clean. The boot matrix (`tools/shots/boot.js`) asserts a draw-call floor
 * for every entry point; this asserts the things a frame cannot show.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, events } from './harness.js';

test('the lobby boots with every module ready and a clean console', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);

  expect(errors, 'console errors (the budget is zero)').toEqual([]);

  const modules = await page.evaluate(() => window.__HOOKS__.modules());
  const down = modules.filter((m) => m.status !== 'ready').map((m) => `${m.id}:${m.status}`);
  expect(down, 'every registered module reached ready').toEqual([]);
  expect(modules.map((m) => m.id).sort()).toEqual([
    'automation', 'battle', 'city', 'collection', 'economy', 'encounter', 'environment', 'hunts',
    'idle', 'offline', 'pokecenter', 'pokemon', 'preview', 'simulation', 'terrain', 'tiles',
    'travel', 'ui',
  ]);

  const log = await events(page);
  const types = log.map((e) => e.type);
  expect(types, 'boot:ready was emitted (it fires before __READY__, so the log must be installed early)').toContain('boot:ready');
  expect(types).toContain('world:loaded');
  expect(types).toContain('scene:entered');
  const scene = log.find((e) => e.type === 'scene:entered');
  expect(scene.payload.sceneId).toBe('demo-city');
  // The opening purse is credited, and it is not "earned".
  const start = log.find((e) => e.type === 'economy:changed' && e.payload.reason === 'start');
  expect(start?.payload.currency).toBe('money');
  expect(start?.payload.total).toBeGreaterThan(0);
});
