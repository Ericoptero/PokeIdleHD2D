/**
 * The party bar: six real slots, a click that opens the party panel already
 * selected on the slot clicked, a drag that reorders, and the marked slot following a
 * mid-fight ally swap rather than the party's own resting order.
 *
 * Driven through real `PointerEvent`s at real buffer coordinates (the gesture test pattern,
 * `tests/flows/hud-windows.spec.js`'s `regions()`/`click()`), never by calling `hud.js`'s
 * functions directly — that would prove nothing about whether the click a player actually
 * makes reaches the party bar's own hit regions rather than, say, the button strip drawn
 * over the same corner of the screen.
 *
 * A party-bar slot's hit region does one job for two different releases: `pointerdown`
 * always starts a drag (`gesture.js`), and a `pointerup` back over the SAME slot (no
 * intervening `pointermove` at all, unlike the window-drag tests in `hud-windows.spec.js`)
 * is what a plain click looks like to `screen.js` — its own `drop.on` reads
 * `payload.index === i` as "that was a click" (`hud.js`'s own comment on the region). Because
 * `screen.js`'s `pointerup` handler computes the release point straight off the real event's
 * `clientX/clientY` rather than off any painted "ghost" position, no intermediate paint is
 * needed between the down and the up the way `windowFrame`'s own reconciliation needs one.
 */
import { test, expect } from '@playwright/test';
import {
  installEventLog, boot, events, step, call, pointer,
} from './harness.js';

/** The hit regions of the last paint, boxes and all — the same shape `g.hit()` builds. */
const regions = (page) => page.evaluate(() => window.__CTX__.get('ui')._screen.regions());

/** Forces one UI frame. `dt >= 0.2` also forces `hud.read()` to refresh (`ui/index.js`'s own
 *  throttle) — needed here because `boot()` pauses the real frame loop that would otherwise
 *  do this on its own every 200 ms of wall clock. */
const paintNow = (page, dt = 0) => call(page, 'ui', '_frame', dt);

/** The centre point of a region's box, in UI buffer pixels. */
const centre = (r) => ({ x: Math.round(r.box.x + r.box.w / 2), y: Math.round(r.box.y + r.box.h / 2) });

/** A real click: down then up at the same point, the way `screen.js`'s listeners see one. */
async function click(page, point) {
  await pointer(page, { type: 'pointerdown', ...point });
  await pointer(page, { type: 'pointerup', ...point });
}

/** `party-slot-i`'s own box, forcing a paint first so the region reflects the current party. */
async function partySlotBox(page, i) {
  await paintNow(page);
  const regs = await regions(page);
  const r = regs.find((x) => x.tag === `party-slot-${i}`);
  expect(r, `no party-slot-${i} region; tags seen: ${[...new Set(regs.map((x) => x.tag))].join(', ')}`)
    .toBeTruthy();
  return r;
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
  const slot1 = await partySlotBox(page, 1);

  await click(page, centre(slot1));
  await paintNow(page);

  expect(await call(page, 'ui', 'openPanel')).toBe('party');
  // `party.js`'s own `cursor` accessor — not part of the panel contract, `travel.js`'s
  // `rows()` precedent for exposing internal state a test needs and nothing else reads.
  const cursor = await page.evaluate(() => window.__CTX__.get('ui')._state.panel.cursor());
  expect(cursor).toBe(1);
  expect(errors, 'no console error opening the party panel from the bar').toEqual([]);
});

test('dragging a slot that never crosses index 0 reorders without a lead change', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await fillPartyToSix(page);

  const before = (await call(page, 'pokemon', 'party')).map((p) => p.instanceId);
  const slot3 = await partySlotBox(page, 3);
  const slot1 = await partySlotBox(page, 1);
  const markBefore = (await events(page)).length;

  await pointer(page, { type: 'pointerdown', ...centre(slot3) });
  await pointer(page, { type: 'pointerup', ...centre(slot1) });
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
  const slot1 = await partySlotBox(page, 1);
  const slot0 = await partySlotBox(page, 0);
  const markBefore = (await events(page)).length;

  await pointer(page, { type: 'pointerdown', ...centre(slot1) });
  await pointer(page, { type: 'pointerup', ...centre(slot0) });
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
