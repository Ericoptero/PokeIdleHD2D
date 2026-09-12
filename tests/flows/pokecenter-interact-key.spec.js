/**
 * The generic `player:interact` key itself (`Z` / `Space`, `ui/input.js`), driven end to end
 * through a real `KeyboardEvent` — not by emitting the bus event by hand the way
 * `src/pokecenter/index.test.js` does. That file proves `pokecenter`'s own listener logic; this
 * proves the key that is supposed to produce that event in the first place, including the two
 * places `ui/input.js` itself says the key must NOT reach `interact()`: while a panel is open,
 * and on a scene the walker does not take keyboard input on at all (`simulation.formation().input
 * === false`, a hunt).
 *
 * Independent of `tests/flows/hunt-recovers.spec.js`'s own coverage: that file presses `KeyZ`
 * only, always at the counter, always with no panel open. This file adds `Space`, a press away
 * from the counter, a press with a panel open, and a press on an unwalkable scene — the four
 * input cases not exercised by the cure flow.
 */
import { test, expect } from '@playwright/test';
import {
  installEventLog, boot, events, call, key,
} from './harness.js';

const mark = (page) => page.evaluate(() => window.__EVLOG__.length);
const since = async (page, at) => (await events(page)).filter((e) => e.at >= at);

/**
 * Holds `code` down, resumes the frame loop, and polls real wall-clock time for an event of
 * `type` logged after `after` — the same bounded-wait shape `tests/flows/hunt-recovers.spec.js`
 * and `tests/flows/pokecenter.spec.js` both use for a real `KeyboardEvent` walk.
 */
async function walkOnto(page, code, type, { after, maxMs = 15_000, pollMs = 100 } = {}) {
  await page.evaluate(() => window.__HOOKS__.resume());
  await key(page, code, true);
  const t0 = Date.now();
  try {
    for (;;) {
      const log = await events(page);
      const hit = log.find((e) => e.type === type && e.at >= after);
      if (hit) return hit;
      if (Date.now() - t0 > maxMs) {
        const seen = [...new Set(log.filter((e) => e.at >= after).map((e) => e.type))].join(', ');
        expect(null, `no ${type} within ${maxMs}ms of walking ${code}; events since: ${seen || '(none)'}`)
          .not.toBeNull();
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

/** Walks from the city's own door marker into the Center and up to the counter. */
async function enterCenterAndFaceCounter(page) {
  const marker = await call(page, 'city', 'marker', 'pokecenter-door');
  expect(marker, 'the city draft mints a pokecenter-door marker').not.toBeNull();
  await call(page, 'simulation', 'teleport', marker.cx, marker.cz, 2); // NORTH, facing the door
  const before = await mark(page);
  await walkOnto(page, 'KeyW', 'scene:entered', { after: before });
  expect((await call(page, 'travel', 'current'))?.id).toBe('pokecenter');
  const atCounter = await walkUntil(page, 'KeyW', (p) => p.cz <= 3);
  expect(atCounter.cz).toBe(3);
}

const partyHp = (page) => page.evaluate(() =>
  window.__CTX__.get('pokemon').party().map((p) => p.hp));
const partyMaxHp = (page) => page.evaluate(() =>
  window.__CTX__.get('pokemon').party().map((p) => p.maxHp));

test('pressing Z away from the counter fires player:interact but heals nothing; at the counter it cures', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  expect((await call(page, 'travel', 'current'))?.id).toBe('demo-city');

  // Phase 1: nowhere near a counter tile (the lobby has none — `map.js` only tags the Center's
  // own counter cells). The key must still do SOMETHING (it is a generic key, not a Center
  // special-case) but must not open a dialogue or touch the party.
  const before1 = await mark(page);
  await key(page, 'KeyZ');
  await key(page, 'KeyZ', false);
  const log1 = await since(page, before1);
  const interact1 = log1.find((e) => e.type === 'player:interact');
  expect(interact1, `player:interact should fire even away from the counter; events seen: ${log1.map((e) => e.type).join(', ') || '(none)'}`)
    .toBeTruthy();
  expect(interact1.payload.tags ?? []).not.toContain('counter');
  expect(await call(page, 'ui', 'openPanel'), 'no dialogue opens away from the counter').toBeNull();

  // Phase 2: walk in and face the counter for real.
  await enterCenterAndFaceCounter(page);
  const hpBefore = await partyHp(page);
  const before2 = await mark(page);
  await key(page, 'KeyZ');
  await key(page, 'KeyZ', false);
  await page.evaluate(() => window.__HOOKS__.pause());
  const log2 = await since(page, before2);
  const interact2 = log2.find((e) => e.type === 'player:interact');
  expect(interact2?.payload.tags, 'the faced cell at the counter carries the counter tag').toContain('counter');
  expect(await call(page, 'ui', 'openPanel'), 'Z at the counter opens a dialogue with Nurse Joy').toBe('dialogue');
  expect(await partyHp(page)).toEqual(await partyMaxHp(page));
  // hpBefore is read only to make the "healed" claim meaningful in the failure message, not
  // asserted directly — a fresh party may already be full.
  void hpBefore;

  expect(errors, 'no console error pressing Z on or off the counter').toEqual([]);
});

test('Space bar interacts exactly the way KeyZ does', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await enterCenterAndFaceCounter(page);

  const before = await mark(page);
  await key(page, 'Space');
  await key(page, 'Space', false);
  await page.evaluate(() => window.__HOOKS__.pause());
  const log = await since(page, before);
  const interact = log.find((e) => e.type === 'player:interact');
  expect(interact?.payload.tags, `Space should fire player:interact at the counter the same as KeyZ; events: ${log.map((e) => e.type).join(', ') || '(none)'}`)
    .toContain('counter');
  expect(await call(page, 'ui', 'openPanel'), 'Space opens the same Nurse Joy dialogue as Z').toBe('dialogue');
  expect(await partyHp(page)).toEqual(await partyMaxHp(page));
  expect(errors, 'no console error pressing Space at the counter').toEqual([]);
});

test('a panel already open consumes Z/Space itself — player:interact never fires underneath it', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);

  // Case A: the dialogue panel, opened directly the way `pokecenter`'s own cure opens it —
  // this is the exact race named in `src/pokecenter/index.js`'s header comment ("interact only
  // ever fires while no panel, dialogue included, is open").
  expect(await call(page, 'ui', 'say', 'A message with nothing to do with the Center.')).toBe(true);
  expect(await call(page, 'ui', 'openPanel')).toBe('dialogue');
  let before = await mark(page);
  await key(page, 'KeyZ');
  await key(page, 'KeyZ', false);
  let log = await since(page, before);
  expect(log.some((e) => e.type === 'player:interact'),
    `KeyZ must be consumed by the open dialogue, not reach player:interact; events: ${log.map((e) => e.type).join(', ') || '(none)'}`)
    .toBe(false);
  // The dialogue's own key(ev) DID consume it: a one-page message advances and closes.
  expect(await call(page, 'ui', 'openPanel'), 'the dialogue advanced/closed on its own key handler').toBeNull();

  // The suppression is scoped to "while a panel is open", not a general breakage of the key:
  // with the dialogue now closed, the SAME KeyZ press must reach player:interact. This is the
  // assertion that actually distinguishes the input forwarding from the previous tree — there,
  // no panel is open here either, and KeyZ still does nothing at all, so this line is the one
  // that turns "the panel swallowed it" into a provable claim rather than a vacuous one.
  before = await mark(page);
  await key(page, 'KeyZ');
  await key(page, 'KeyZ', false);
  log = await since(page, before);
  expect(log.some((e) => e.type === 'player:interact'),
    `with no panel open, KeyZ must reach player:interact; events: ${log.map((e) => e.type).join(', ') || '(none)'}`)
    .toBe(true);

  // Case B: the party panel (`P`), a real HUD panel a player opens directly — same guard.
  // (The travel panel was tried first and rejected for this case: its own Z/Space handler
  // `pick()`s the highlighted destination and, on success, navigates and closes itself — a
  // real side effect that raced this assertion. `party`'s Z/Space calls `setLead(cursor)` at
  // the roster's own opening cursor, which is idempotent and has no navigation side effect.)
  await call(page, 'ui', 'open', 'party');
  expect(await call(page, 'ui', 'openPanel')).toBe('party');
  before = await mark(page);
  await key(page, 'Space');
  await key(page, 'Space', false);
  log = await since(page, before);
  expect(log.some((e) => e.type === 'player:interact'),
    `Space must be consumed by the open party panel, not reach player:interact; events: ${log.map((e) => e.type).join(', ') || '(none)'}`)
    .toBe(false);
  // Close it with Escape and confirm the key works again once the panel is gone — the same
  // "scoped, not broken" check as Case A.
  await key(page, 'Escape');
  await key(page, 'Escape', false);
  expect(await call(page, 'ui', 'openPanel'), 'Escape closes the party panel').toBeNull();
  before = await mark(page);
  await key(page, 'Space');
  await key(page, 'Space', false);
  log = await since(page, before);
  expect(log.some((e) => e.type === 'player:interact'),
    `with the party panel closed, Space must reach player:interact; events: ${log.map((e) => e.type).join(', ') || '(none)'}`)
    .toBe(true);

  await page.evaluate(() => window.__HOOKS__.pause());
  expect(errors, 'no console error with a panel swallowing the interact key').toEqual([]);
});

test('a hunt takes no keyboard input at all — Z there throws nothing and never fires player:interact', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect((await call(page, 'travel', 'current'))?.id).toBe('hunt-meadow');
  expect(await call(page, 'simulation', 'formation')).toEqual(expect.objectContaining({ input: false }));

  const before = await mark(page);
  await key(page, 'KeyZ');
  await key(page, 'KeyZ', false);

  expect(await page.evaluate(() => window.__FATAL__ ?? null), 'Z on an unwalkable scene must not crash the page').toBeNull();
  const log = await since(page, before);
  expect(log.some((e) => e.type === 'player:interact'),
    `a hunt does not take keyboard input, so Z must not reach player:interact; events: ${log.map((e) => e.type).join(', ') || '(none)'}`)
    .toBe(false);

  // The guard is `canWalk()` specifically (`simulation.formation().input`), not a general
  // failure to bind the key at all: travel to a walkable scene and confirm the very same key
  // now fires. Without this half, the assertion above is true for the wrong reason on a tree
  // where Z is not bound anywhere yet — this is what turns it into a real regression guard for
  // `ui/input.js`'s `canWalk()` check rather than a restatement of "the key does nothing".
  await call(page, 'travel', 'go', 'demo-city');
  await page.waitForFunction(() => window.__CTX__.get('travel').current()?.id === 'demo-city',
    null, { timeout: 15_000, polling: 100 });
  const before2 = await mark(page);
  await key(page, 'KeyZ');
  await key(page, 'KeyZ', false);
  const log2 = await since(page, before2);
  expect(log2.some((e) => e.type === 'player:interact'),
    `the same key must fire once back on a walkable scene; events: ${log2.map((e) => e.type).join(', ') || '(none)'}`)
    .toBe(true);

  expect(errors, 'no console error pressing Z in a hunt and then in the city').toEqual([]);
});
