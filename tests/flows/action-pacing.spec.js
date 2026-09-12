/**
 * One action at a time: a turn where both sides act must not put their two
 * `battle:strike` events in the same tick, or anywhere near it — that was the bug ("attacks at
 * the same time") the brief is about, and `event.at` in the bus log is an **array index**
 * (`harness.js`'s `installEventLog`), not a sim tick, so proving a real gap needs the sim tick
 * each event actually landed on, tracked here by stepping in small, counted chunks rather than
 * jumping straight to the next event.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, step, events } from './harness.js';

/** Small enough to tell "the same tick" from "eighteen ticks apart" with room to spare. */
const CHUNK = 4;
const MAX_TICKS = 3000;

test('two strikes in the same turn land on different ticks, at least one action-beat apart', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  // Read straight off the config the page actually booted with, not assumed — a URL override
  // must not silently make this test's floor wrong.
  const configuredBeat = await page.evaluate(() => window.__CTX__.config.actionSteps);
  expect(configuredBeat, 'actionSteps is a real, positive number').toEqual(expect.any(Number));

  // Dedup by the log's own index (`e.at`), not by payload identity — `events(page)` round-trips
  // every payload through Playwright's serialization on each poll, so the "same" event fetched
  // twice is never `===` the second time, and a reference check would record it as new again on
  // every later poll, with whatever tick that later poll happened to land on.
  /** @type {{at:number, payload:object, tick:number}[]} */
  const seenStrikes = [];
  const seenAt = new Set();
  let tick = 0;
  let sawTurn = null;
  for (; tick <= MAX_TICKS; tick += CHUNK) {
    const log = await events(page);
    for (const e of log) {
      if (e.type !== 'battle:strike' || seenAt.has(e.at)) continue;
      seenAt.add(e.at);
      seenStrikes.push({ at: e.at, payload: e.payload, tick });
      if (e.payload.turn != null) {
        const sameTurn = seenStrikes.filter((s) => s.payload.turn === e.payload.turn);
        if (sameTurn.length >= 2) sawTurn = e.payload.turn;
      }
    }
    if (sawTurn != null) break;
    await step(page, CHUNK);
  }
  expect(sawTurn, `no turn produced two strikes within ${MAX_TICKS} ticks`).not.toBeNull();

  const pair = seenStrikes.filter((s) => s.payload.turn === sawTurn).slice(0, 2);
  expect(pair, 'both strikes of the two-strike turn were recorded').toHaveLength(2);
  const gap = pair[1].tick - pair[0].tick;

  // Not simultaneous, and not "close" — a real beat apart. `CHUNK`'s own resolution is why the
  // floor is `configuredBeat - CHUNK` rather than the exact value: the second strike is only
  // ever detected on a chunk boundary, so the measured gap can undershoot the true one by up
  // to one chunk.
  expect(gap, `strikes ${JSON.stringify(pair.map((s) => s.tick))} for turn ${sawTurn}`)
    .toBeGreaterThanOrEqual(configuredBeat - CHUNK);

  expect(errors, 'no console error while pacing was measured').toEqual([]);
});
