/**
 * The party list: six real rows in `#ui-dom` (`src/ui/dom/hud.js`, converted off the canvas
 * bar in Stage 3), a click that opens the party panel already selected on the row clicked, a
 * drag that reorders, and the marked row following a mid-fight ally swap rather than the
 * party's own resting order.
 *
 * Driven through real mouse input at real screen coordinates (`page.mouse`, which Chromium
 * synthesises into genuine `pointerdown`/`pointermove`/`pointerup` events — the same events
 * `dom/dnd.js`'s own `window` listeners read) rather than by calling `dom/hud.js`'s functions
 * directly, for the same reason the canvas version of this file gave: proving the click a
 * player actually makes reaches the right element, not merely that the underlying data
 * mutation works.
 *
 * `dom/dnd.js`'s own contract: `pointerdown` always starts a drag, and a `pointerup` back
 * over the SAME row (no intervening `pointermove`) is what a plain click looks like — its own
 * `onClick` callback is exactly `dom/hud.js`'s "open the party panel on this index".
 */
import { test, expect } from '@playwright/test';
import {
  installEventLog, boot, events, step, call,
} from './harness.js';

/** Forces one UI frame. `dt >= 0.2` also forces `hud.read()` to refresh and `dom/hud.js`'s
 *  own `update()` to run (`ui/index.js`'s own throttle) — needed here because `boot()` pauses
 *  the real frame loop that would otherwise do this on its own every 200 ms of wall clock. */
const paintNow = (page, dt = 0) => call(page, 'ui', '_frame', dt);

/** `hud-party-i`'s own centre, in real screen (client) coordinates — `page.mouse` works in
 *  this space, unlike the canvas-buffer pixels `tests/flows/hud-windows.spec.js`'s `pointer()`
 *  helper converts. Forces a paint first so the row reflects the current party. */
async function partySlotCentre(page, i) {
  await paintNow(page);
  const box = await page.locator(`[data-ui="hud-party-${i}"]`).boundingBox();
  expect(box, `no [data-ui="hud-party-${i}"] element on screen`).toBeTruthy();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A real click: move, down, then up at the same point. */
async function click(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** A real drag: down over `from`, a move (so `dom/dnd.js` registers a drop target, not a
 *  click), then up over `to`. */
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

/** A fresh `?seed=1337` game starts with three party members (Oshawott, Snivy, Tepig) — filled
 *  out to six generic fillers so every slot has a drag partner, the way a full party does. */
async function fillPartyToSix(page) {
  const report = await page.evaluate(() => {
    const pk = window.__CTX__.get('pokemon');
    const filler = ['charmander', 'squirtle', 'bulbasaur', 'eevee', 'pikachu', 'magikarp'];
    const minted = [];
    let i = 0;
    while (pk.party().length < 6 && i < filler.length) {
      const inst = pk.createInstance({ species: filler[i], level: 5, seed: 100 + i });
      minted.push({ species: filler[i], ok: !!inst && pk.addToParty(inst) });
      i++;
    }
    return { minted, length: pk.party().length };
  });
  for (const m of report.minted) expect(m.ok, `fixture species "${m.species}" must mint and join`).toBe(true);
  expect(report.length).toBe(6);
  // `hud.js`'s own snapshot (`state.hud.party`) is what `draw()` reads, and it is only
  // refreshed on the 0.2 s poll `ui/index.js`'s `frame()` runs — paused along with everything
  // else by `boot()`. Without forcing one here, the bar keeps drawing (and registering hit
  // regions for) the three-member party this fixture just grew past.
  await paintNow(page, 0.25);
}

/**
 * Steps the sim in `chunk`-tick bursts, evaluating `fn(arg)` in the page after each burst,
 * until it returns something truthy — or `maxTicks` have passed, in which case the assertion
 * fails with a message instead of a bare timeout (the same discipline `harness.js`'s own
 * `stepUntil` uses for a bus event; this is for a live encounter's own runtime state, which is
 * not an event at all).
 */
async function stepUntilTrue(page, fn, arg, { chunk = 10, maxTicks = 4000 } = {}) {
  let ticks = 0;
  for (;;) {
    const result = await page.evaluate(fn, arg);
    if (result) return result;
    if (ticks >= maxTicks) {
      expect(null, `condition on ${JSON.stringify(arg)} never became true within ${maxTicks} ticks`)
        .not.toBeNull();
    }
    await step(page, chunk);
    ticks += chunk;
  }
}

test('clicking a filled party-bar slot opens the party panel already selected on it', async ({ page }) => {
  const errors = await boot(page);
  await fillPartyToSix(page);
  const slot1 = await partySlotCentre(page, 1);

  await click(page, slot1);
  await paintNow(page);

  expect(await call(page, 'ui', 'openPanel')).toBe('party');
  // `screens/party.js`'s own `model()` accessor — not part of the screen contract, `travel.js`'s
  // `rows()` precedent for exposing internal state a test needs and nothing else reads.
  const cursor = await page.evaluate(() => window.__CTX__.get('ui')._state.panel.model().cursor);
  expect(cursor).toBe(1);
  expect(errors, 'no console error opening the party panel from the bar').toEqual([]);
});

test('dragging a slot that never crosses index 0 reorders without a lead change', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await fillPartyToSix(page);

  const before = (await call(page, 'pokemon', 'party')).map((p) => p.instanceId);
  const slot3 = await partySlotCentre(page, 3);
  const slot1 = await partySlotCentre(page, 1);
  const markBefore = (await events(page)).length;

  await drag(page, slot3, slot1);
  await paintNow(page);

  const after = (await call(page, 'pokemon', 'party')).map((p) => p.instanceId);
  expect(after, 'the third member moved to the second slot').toEqual(
    [before[0], before[3], before[1], before[2], before[4], before[5]]);
  expect(after[0], 'slot 0 did not move in this drag').toBe(before[0]);

  const since = (await events(page)).slice(markBefore);
  expect(since.some((e) => e.type === 'party:leadChanged'),
    'a reorder that never touches slot 0 must not fire party:leadChanged').toBe(false);
  expect(errors, 'no console error dragging within the bench').toEqual([]);
});

test('dragging a non-lead onto slot 0 fires party:leadChanged and turns the walker', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await fillPartyToSix(page);

  const before = (await call(page, 'pokemon', 'party')).map((p) => p.instanceId);
  const slot1 = await partySlotCentre(page, 1);
  const slot0 = await partySlotCentre(page, 0);
  const markBefore = (await events(page)).length;

  await drag(page, slot1, slot0);
  await paintNow(page);

  const after = (await call(page, 'pokemon', 'party')).map((p) => p.instanceId);
  expect(after[0], 'the dragged member is now leading').toBe(before[1]);

  const since = (await events(page)).slice(markBefore);
  const fired = since.find((e) => e.type === 'party:leadChanged');
  expect(fired, 'a drag onto slot 0 must fire party:leadChanged').toBeTruthy();
  expect(fired.payload.instanceId).toBe(before[1]);

  // `simulation` listens for the same event and rebuilds the conga line — the overworld
  // sprite the player actually watches walk must be the new lead, not a stale one.
  expect((await call(page, 'simulation', 'follower'))?.instanceId).toBe(before[1]);
  expect(errors, 'no console error dragging the bench onto the lead slot').toEqual([]);
});

test('the marked slot follows a mid-fight ally swap, not the party\'s own order', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await call(page, 'travel', 'go', 'hunt-meadow');
  await page.waitForFunction(() => window.__CTX__.get('travel').current()?.id === 'hunt-meadow',
    null, { timeout: 30_000, polling: 100 });

  const originalLeadId = (await call(page, 'pokemon', 'party'))[0].instanceId;
  // Down to a sliver: the very next hit that lands faints it, which is what forces
  // `encounter`'s `nextAlly` to send the next party member in mid-duel —
  // the exact scenario this rule exists for.
  await page.evaluate((id) => {
    const pk = window.__CTX__.get('pokemon');
    pk.damage(id, pk.instance(id).maxHp - 1);
  }, originalLeadId);

  const swap = await stepUntilTrue(page, (leadId) => {
    const enc = window.__CTX__.get('encounter');
    const active = enc?.active?.();
    if (!active?.battle || active.battle.win !== null) return null; // no live fight right now
    const a = active.duel?.run?.state?.a;
    return (a && a.instanceId !== leadId) ? { activeId: a.instanceId, win: active.battle.win } : null;
  }, originalLeadId, { chunk: 5, maxTicks: 6000 });

  expect(swap.win, 'the swap must be visible before the fight resolves, not after').toBeNull();
  expect(swap.activeId).not.toBe(originalLeadId);

  // `ui.snapshot()` — not a pixel — is `hud.js`'s own `read()` output; forced fresh here
  // because `boot()` paused the frame loop that would otherwise refresh it every 200 ms.
  await paintNow(page, 0.25);
  const snap = await call(page, 'ui', 'snapshot');
  expect(snap.activeId, 'the bar marks the live combatant, not party()[0]').toBe(swap.activeId);
  expect(snap.activeId).not.toBe(originalLeadId);

  // The window after a fight resolves but before `encounter.resolve()` runs `pokemon.setLead`
  // for the swapped-in finisher (`encounter/index.js`'s own comment: the player gets several
  // seconds to decide whether to throw a ball) — the exact gap an earlier version got
  // wrong: it gated the party bar's own read on `win === null`, so for this whole window the
  // bar reverted to the original, fainted lead while `panels/battle.js`'s card kept correctly
  // showing the finisher (`battle.js:125-127` reads `duel.run.state.a` for as long as
  // `duel.engine` exists, `win` included — no such gate).
  const resolved = await stepUntilTrue(page, (_fromId) => {
    const enc = window.__CTX__.get('encounter');
    const active = enc?.active?.();
    if (!active?.battle || active.battle.win === null) return null; // still mid-fight
    const a = active.duel?.run?.state?.a;
    return a ? { activeId: a.instanceId, win: active.battle.win } : null;
  }, swap.activeId, { chunk: 5, maxTicks: 6000 });

  expect(resolved.win, 'the fight must actually be over for this to test the post-resolution window').not.toBeNull();
  await paintNow(page, 0.25);
  const afterResolve = await call(page, 'ui', 'snapshot');
  expect(afterResolve.activeId,
    'the bar must keep marking the finisher through the post-resolution window, not revert to the stale lead')
    .toBe(resolved.activeId);
  expect(afterResolve.activeId).not.toBe(originalLeadId);

  expect(errors, 'no console error through a mid-fight ally swap and its resolution').toEqual([]);
});
