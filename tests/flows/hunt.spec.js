/**
 * The hunt loop at `/?scene=hunt-meadow`: the party walks the circuit, meets a wild on a slot,
 * the fight is stepped turn by turn, and it ends — and if it was won, the player can throw a
 * ball inside the window the game leaves open (a world-anchored tooltip now,
 * `src/ui/dom/capture.js` — there is no docked battle card any more). Every step is a bus
 * event; nothing here reads a pixel. `?scene=` stands the trainer-level lock down for that id
 * (src/travel/index.js).
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, step, events, stepUntil, key, call } from './harness.js';

/** Forces one world-layer DOM sync — `window.__HOOKS__.step()` only drives `registry.tick`,
 *  never `registry.lateFrame`, so the capture tooltip (positioned there) does not update from
 *  stepping alone (`tests/flows/plates.spec.js`'s own header explains the same gap). */
const paintNow = (page) => call(page, 'ui', '_lateFrame');

test('a hunt reaches an encounter, fights it, and resolves it', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  const scene = (await events(page)).find((e) => e.type === 'scene:entered');
  expect(scene?.payload.sceneId).toBe('hunt-meadow');

  // 1. The circuit walk produces an encounter.
  const started = await stepUntil(page, 'encounter:started', { chunk: 20, maxTicks: 3000 });
  const enc = started.hit.payload;
  expect(enc).toEqual(expect.objectContaining({ species: expect.any(String), level: expect.any(Number), biome: 'hunt-meadow' }));
  expect(typeof enc.index).toBe('number');
  const battleStarted = started.log.find((e) => e.type === 'battle:started' && e.at < started.hit.at);
  expect(battleStarted, 'battle:started precedes encounter:started').toBeTruthy();
  // No panel opens for a fight any more — balloons/floaters/the capture tooltip are the whole
  // on-screen account of it, and the walk stays visible underneath the whole time.
  expect(await call(page, 'ui', 'openPanel'), 'a hunt fight opens no panel').toBeNull();

  // 2. The fight is stepped, one turn per T.TURN ticks, and ends.
  const ended = await stepUntil(page, 'battle:ended', { chunk: 12, maxTicks: 2400, after: started.hit.at });
  const strikes = ended.log.filter((e) => e.type === 'battle:strike' && e.at > started.hit.at && e.at < ended.hit.at);
  expect(strikes.length, 'at least one blow was called out before the fight ended').toBeGreaterThan(0);
  const outcome = ended.hit.payload;
  expect(outcome).toEqual(expect.objectContaining({ won: expect.any(Boolean), turns: expect.any(Number) }));
  expect(outcome.turns).toBeGreaterThan(0);

  // The fight's own writeback has already run by the time `battle:ended` fires
  // (`endFight()`, src/encounter/index.js) — `outcome.allyHp` is the engine's own true final
  // HP for whoever was fighting. Only when the fight actually cost HP does this catch
  // anything: the bug this guards against (a stale `combatantOf()` snapshot that never
  // reflected what the duel did) always read back the party's STARTING hp, so a clean sweep
  // with zero damage taken would pass either way. When damage *was* taken, the party's real
  // HP must already show it — not "heal itself" back to full the instant the encounter
  // resolves.
  if (outcome.allyHp != null && outcome.allyMaxHp != null && outcome.allyHp < outcome.allyMaxHp) {
    const party = await call(page, 'pokemon', 'party');
    const hurt = party.find((m) => m.hp === outcome.allyHp && m.maxHp === outcome.allyMaxHp);
    expect(hurt, `some party member's real HP (${party.map((m) => `${m.hp}/${m.maxHp}`).join(', ')}) ` +
      `matches the fight's own final ${outcome.allyHp}/${outcome.allyMaxHp} — it must not have healed back to full`)
      .toBeTruthy();
  }

  if (outcome.won) {
    // 3a. A won fight leaves a throw window open (`config.manualThrowSeconds` while Auto-Catch
    // is off, `src/encounter/index.js`'s `leaveSteps()`) with the capture tooltip up over the
    // wild; one ball, one roll, and the encounter resolves in the same tick as the throw
    // (attempt() calls resolve() synchronously).
    await step(page, 4);
    await paintNow(page);
    expect(await page.locator('[data-ui="capture-throw"]').isVisible(),
      'the capture tooltip is up in the throw window').toBe(true);
    const before = (await events(page)).length;
    await key(page, 'KeyZ');
    const thrown = (await events(page)).filter((e) => e.at >= before);
    const outcomes = thrown.filter((e) => e.type === 'catch:succeeded' || e.type === 'catch:failed');
    expect(outcomes.map((e) => e.type), 'exactly one catch outcome for one throw').toHaveLength(1);
    expect(outcomes[0].payload).toEqual(expect.objectContaining({ species: enc.species, ball: expect.any(String) }));
    const resolved = thrown.find((e) => e.type === 'encounter:resolved');
    expect(resolved, 'encounter:resolved follows the throw').toBeTruthy();
    expect(resolved.at).toBeGreaterThan(outcomes[0].at);
    expect(resolved.payload).toEqual(expect.objectContaining({ outcome: 'win', species: enc.species, index: enc.index }));
    expect(resolved.payload.caught).toBe(outcomes[0].type === 'catch:succeeded');
    if (resolved.payload.caught) {
      expect(thrown.some((e) => e.type === 'collection:added'), 'a catch reaches the collection').toBe(true);
    }
  } else {
    // 3b. A lost fight with a bench falls to the next member; a wiped party pays and is taken
    // to the Pokémon Center. Either way the encounter is over, not stuck.
    const over = await stepUntil(page, 'encounter:resolved', { chunk: 12, maxTicks: 2400, after: ended.hit.at });
    expect(over.hit.payload.index).toBe(enc.index);
  }

  // Observed flow outcome — a flow that passes in a second
  // should say which branch it took and how far it walked.
  test.info().annotations.push({ type: 'path', description:
    `encounter after ${started.ticks} ticks: ${enc.species} L${enc.level}; fight ${outcome.won ? 'won' : 'lost'} in ${outcome.turns} turns, ${strikes.length} strikes, ${ended.ticks} ticks` });

  // 4. The capture tooltip closes with the encounter, and the walk resumes: another tile is
  // entered.
  await step(page, 40);
  await paintNow(page);
  expect(await page.locator('[data-ui="capture-throw"]').isVisible(),
    'the capture tooltip is gone after the encounter resolves').toBe(false);
  const after = (await events(page)).filter((e) => e.type === 'player:enteredTile' && e.at > ended.hit.at);
  expect(after.length, 'the party is walking again').toBeGreaterThan(0);

  // 5. No cutscene caption. The wild was already on the map; nothing announced its arrival
  // (see tests/flows/field-encounter.spec.js for the handover itself).
  const allEvents = await events(page);
  const toasts = allEvents.filter((e) => e.type === 'ui:toast').map((e) => String(e.payload?.text ?? ''));
  expect(toasts.filter((t) => /appeared/i.test(t)), 'no "a wild X appeared" banner anywhere in the flow').toEqual([]);

  expect(errors, 'no console error during the whole flow').toEqual([]);
});
