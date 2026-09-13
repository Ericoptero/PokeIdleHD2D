/**
 * The trainer panel at `/?seed=1337`: the level/wins bar tracks `economy.trainer()`
 * after a real win, and the Upgrades block reflects a real purchase — both read off the live
 * panel's own content model (`window.__CTX__.get('ui')._state.panel.model()`, the same
 * `_state.panel`/`model()` read `party-bar.spec.js` uses for its own cursor check), never
 * off a pixel.
 *
 * `trainerFromWins` is imported directly from `src/economy/trainer.js` for the *expected* side
 * of the level assertion — a literal per its own documented triangular formula, not a second
 * live call to `economy.trainer()` (two live reads reorder identically and agree
 * even when both are wrong).
 */
import { test, expect } from '@playwright/test';
import {
  installEventLog, boot, step, events, stepUntil, call,
} from './harness.js';
import { trainerFromWins } from '../../src/economy/trainer.js';

/** Forces one UI frame so `open()`'s state change is actually painted. */
const paintNow = (page) => call(page, 'ui', '_frame', 0);

const panelModel = (page) => page.evaluate(() => window.__CTX__.get('ui')._state.panel.model());

/**
 * Steps through meadow encounters, unattended (nobody throws a ball — `encounter.js`'s
 * `resolveUnattended` fires on its own once the throw window passes, crediting the same
 * `outcome: battle.win ? 'win' : 'flee'` a manual throw would), until one resolves as a win.
 * Seed 1337 is fixed, so this is a deterministic number of encounters, not a flaky retry.
 */
async function winOneBattle(page, { maxAttempts = 10 } = {}) {
  let after = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const started = await stepUntil(page, 'encounter:started', { chunk: 20, maxTicks: 3000, after });
    const resolved = await stepUntil(page, 'encounter:resolved', { chunk: 12, maxTicks: 2400, after: started.hit.at });
    after = resolved.hit.at;
    if (resolved.hit.payload.outcome === 'win') return resolved;
    await step(page, 20); // let the card close before the next lap starts a new encounter
  }
  const seen = [...new Set((await events(page)).map((e) => e.type))].join(', ');
  expect(null, `no winning battle in ${maxAttempts} meadow encounters at seed 1337; events seen: ${seen}`).not.toBeNull();
  return null;
}

test('winning a battle advances the trainer panel\'s level/wins bar by exactly what trainerFromWins predicts', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  await winOneBattle(page);

  const winsAfter = (await call(page, 'economy', 'progress')).battlesWon;
  expect(winsAfter).toBeGreaterThan(0);
  const expected = trainerFromWins(winsAfter);

  expect(await call(page, 'ui', 'open', 'trainer')).toBe(true);
  await paintNow(page);
  const model = await panelModel(page);
  expect(model).toEqual(expect.objectContaining({
    level: expected.level, wins: expected.wins, into: expected.into, need: expected.need, next: expected.next,
  }));

  expect(errors, 'no console error winning a battle and reading the trainer panel').toEqual([]);
});

test('buying an upgrade updates the trainer panel\'s Upgrades block to match economy.upgradeLevel/upgradeCost exactly', async ({ page }) => {
  const errors = await boot(page);

  // `payday` carries no `unlock` requirement (`economy/upgrades.js`) and the opening purse
  // (₽100,000 minus the ~₽10,600 starting kit) comfortably covers its ₽12,000 first level, so
  // this is reachable from a fresh save with no other setup — the same call the shop's own
  // Upgrades shelf makes (`screens/shop.js`: `e.buyUpgrade?.(item.id, n)`).
  const levelBefore = await call(page, 'economy', 'upgradeLevel', 'payday');
  const bought = await call(page, 'economy', 'buyUpgrade', 'payday', 1);
  expect(bought, 'the purchase must actually go through, or this test proves nothing').toBe(1);

  const levelAfter = await call(page, 'economy', 'upgradeLevel', 'payday');
  const costAfter = await call(page, 'economy', 'upgradeCost', 'payday', 1);
  expect(levelAfter).toBe(levelBefore + 1);

  expect(await call(page, 'ui', 'open', 'trainer')).toBe(true);
  await paintNow(page);
  const model = await panelModel(page);
  const row = model.sections.find((s) => s.id === 'upgrades').rows.find((r) => r.id === 'payday');
  expect(row, 'the Upgrades block must carry a "payday" row').toBeTruthy();
  expect(row.level).toBe(levelAfter);
  expect(row.cost).toBe(costAfter);

  expect(errors, 'no console error buying an upgrade and reading the trainer panel').toEqual([]);
});
