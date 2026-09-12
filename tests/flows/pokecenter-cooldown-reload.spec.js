/**
 * The cure's cooldown (`heal.js`, `HEAL_COOLDOWN_MS`) is keyed off `ctx.clock.wallMs()` —
 * `Date.now()` (`src/core/clock.js`) — specifically so it survives a closed tab, not just a
 * live session. `src/pokecenter/index.test.js` proves the save slice round-trips through a
 * stubbed `ctx.clock.wallMs`; it never drives an actual `page.reload()`, so a real boot's own
 * `offline.boot()` → `pokecenter.loadState()` wiring — including whatever `discoverProviders`
 * does at initialization — is untested
 * end to end. This drives it for real: cure once, persist, reload, and confirm the cooldown
 * reads back as "still active" rather than resetting to "never healed" on every fresh boot.
 */
import { test, expect } from '@playwright/test';
import {
  installEventLog, boot, call, key, prop,
} from './harness.js';

async function walkOnto(page, code, type, { after, maxMs = 15_000, pollMs = 100 } = {}) {
  await page.evaluate(() => window.__HOOKS__.resume());
  await key(page, code, true);
  const t0 = Date.now();
  try {
    for (;;) {
      const log = await page.evaluate(() => window.__EVLOG__ ?? []);
      const hit = log.find((e) => e.type === type && e.at >= after);
      if (hit) return hit;
      if (Date.now() - t0 > maxMs) {
        expect(null, `no ${type} within ${maxMs}ms of walking ${code}`).not.toBeNull();
      }
      await page.waitForTimeout(pollMs);
    }
  } finally {
    await key(page, code, false);
  }
}

async function walkUntil(page, code, predicate, { maxMs = 15_000, pollMs = 100 } = {}) {
  await page.evaluate(() => window.__HOOKS__.resume());
  await key(page, code, true);
  const t0 = Date.now();
  try {
    for (;;) {
      const player = await call(page, 'simulation', 'player');
      if (predicate(player)) return player;
      if (Date.now() - t0 > maxMs) {
        expect(null, `walking ${code} never reached the target cell; last at ${JSON.stringify(player)}`)
          .not.toBeNull();
      }
      await page.waitForTimeout(pollMs);
    }
  } finally {
    await key(page, code, false);
  }
}

test('the cure\'s cooldown survives a real page reload instead of resetting to never-healed', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);

  const marker = await call(page, 'city', 'marker', 'pokecenter-door');
  await call(page, 'simulation', 'teleport', marker.cx, marker.cz, 2);
  const before = await page.evaluate(() => window.__EVLOG__.length);
  await walkOnto(page, 'KeyW', 'scene:entered', { after: before });
  await walkUntil(page, 'KeyW', (p) => p.cz <= 3);

  await key(page, 'KeyZ');
  await key(page, 'KeyZ', false);
  await page.evaluate(() => window.__HOOKS__.pause());

  const firstCure = (await call(page, 'pokecenter', 'saveState')).lastHealMs;
  expect(firstCure, 'the first cure stamps a real timestamp').not.toBeNull();
  expect(typeof firstCure).toBe('number');

  await call(page, 'offline', 'persist', 'flow');
  const keys = await prop(page, 'offline', 'keys');
  const raw = await page.evaluate((k) => localStorage.getItem(k), keys.save);
  const doc = JSON.parse(raw);
  expect(doc.slices?.pokecenter?.lastHealMs, 'the saved document itself carries the cooldown stamp')
    .toBe(firstCure);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 45_000, polling: 100 });
  expect(await page.evaluate(() => window.__FATAL__ ?? null)).toBeNull();

  // Not reset: the exact same wall-clock stamp reads back, not `null` ("never healed").
  const afterReload = (await call(page, 'pokecenter', 'saveState')).lastHealMs;
  expect(afterReload, 'the cooldown must not reset to never-healed on a fresh boot').toBe(firstCure);

  // And behaviourally on cooldown: reload happens well inside HEAL_COOLDOWN_MS (60s) of the
  // cure, so pressing Z again at the counter right after boot must refuse, not re-cure —
  // observable as `lastHealMs` staying exactly where it was (a second cure would move it later).
  //
  // Known position-restore issue: reload can put the player at the scene spawn
  // instead of the saved counter cell. This test checks cooldown persistence, so walk
  // back to the counter explicitly before interacting.
  expect((await call(page, 'travel', 'current'))?.id).toBe('pokecenter');
  await walkUntil(page, 'KeyW', (p) => p.cz <= 3);
  await page.evaluate(() => window.__HOOKS__.pause());

  await key(page, 'KeyZ');
  await key(page, 'KeyZ', false);
  const stillOnCooldown = (await call(page, 'pokecenter', 'saveState')).lastHealMs;
  expect(stillOnCooldown, 'a second attempt seconds later is refused — the stamp does not move').toBe(firstCure);

  expect(errors, 'no console error curing, persisting, reloading and retrying').toEqual([]);
});
