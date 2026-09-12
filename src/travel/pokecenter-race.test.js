/**
 * `travel.go()` racing itself — the exact shape a player produces by stepping onto the city's
 * `door:pokecenter` tile twice in quick succession (`src/pokecenter/index.js`'s door listener
 * calls `nav.go('pokecenter')` from a `queueMicrotask` on every `player:enteredTile`, and
 * nothing stops two of those microtasks queuing back to back if the player oscillates on and
 * off the door cell before the first hop's `terrain.load()` resolves), and the shape a console
 * user produces by calling `travel.go()` twice without awaiting the first.
 *
 * `src/travel/selftest.js` never calls `go()` a second time before
 * the first has settled, and never round-trips a save whose `sceneId` is the hidden `pokecenter`
 * destination specifically (its save-round-trip case, #32-34, uses `hunt-coast`). Both gaps are
 * closed here, written independently against the module's real code — not the selftest's
 * `makeWorld` fixture, though the shape of a minimal stub ctx is necessarily similar, since
 * `travel/index.js`'s own `init(ctx)` contract dictates what a caller must supply.
 *
 * Proven able to fail: on the previous tree `travel/index.js` has no `pokecenter` destination
 * at all, so `find('pokecenter')` returns null and every assertion below that expects a
 * successful hop fails immediately (`travel: no destination "pokecenter"`, `entered` stays
 * empty, `current()` stays null).
 */
import { describe, it, expect } from 'vitest';
import travel from './index.js';

/** A world just real enough to answer `travel`'s questions, built fresh per test. */
function makeWorld({ trainerLevel = 1, pokecenterDelayMs = 0 } = {}) {
  const entered = [];
  const errors = [];
  const modules = {
    city: { enter: async () => { entered.push('demo-city'); }, formation: () => ({}) },
    pokecenter: {
      enter: async () => {
        if (pokecenterDelayMs) await new Promise((r) => { setTimeout(r, pokecenterDelayMs); });
        entered.push('pokecenter');
      },
      formation: () => ({}),
    },
    hunts: {
      list: () => [{ id: 'meadow', name: 'Verdant Meadow', requiredLevel: 0 }],
      enter: async (id) => { entered.push(`hunt-${id}`); },
    },
    economy: { trainer: () => ({ level: trainerLevel }) },
    encounter: { active: () => false, cancel: () => {} },
    simulation: { halt: () => {} },
    offline: null,
  };
  const ctx = {
    bus: { emit: () => {}, on: () => () => {} },
    config: { scene: null, showcase: null, seed: 1337 },
    log: { info: () => {}, warn: () => {}, error: (m) => errors.push(String(m)) },
    get: (id) => modules[id] ?? { __missing: true },
  };
  return { api: travel.init(ctx), entered, errors };
}

describe('travel.go() called a second time before the first has settled', () => {
  it('to the SAME destination — the door-stepped-on-twice case: refused, not duplicated', async () => {
    const { api, entered, errors } = makeWorld();
    const p1 = api.go('pokecenter');
    const p2 = api.go('pokecenter'); // fired synchronously, before p1's `await owner.enter()` returns
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1, r2].filter(Boolean)).toHaveLength(1);
    expect(entered).toEqual(['pokecenter']); // built exactly once, never twice
    expect(api.current()?.id).toBe('pokecenter');
    expect(api.busy(), 'never left wedged mid-transition').toBe(false);
    expect(errors).toEqual([]);
  });

  it('to a DIFFERENT destination — a console user racing a hunt against the Center: the first wins, the second is refused', async () => {
    const { api, entered, errors } = makeWorld({ pokecenterDelayMs: 5 });
    const p1 = api.go('pokecenter');
    const p2 = api.go('hunt-meadow');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(entered).toEqual(['pokecenter']); // the hunt was never built
    expect(api.current()?.id).toBe('pokecenter');
    expect(api.busy()).toBe(false);
    expect(errors).toEqual([]);

    // Not wedged for the rest of the session — a later, un-raced go() still works.
    expect(await api.go('demo-city')).toBe(true);
    expect(api.current()?.id).toBe('demo-city');
  });

  it('three-way race — only one destination is ever built, whichever direction it races', async () => {
    const { api, entered } = makeWorld({ pokecenterDelayMs: 5 });
    const results = await Promise.all([
      api.go('pokecenter'), api.go('hunt-meadow'), api.go('demo-city'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(entered).toHaveLength(1);
    expect(api.current()?.id).toBe(entered[0]);
    expect(api.busy()).toBe(false);
  });
});

describe('a save whose last scene was the hidden Pokemon Center', () => {
  it('round-trips through saveState()/loadState() into the NEXT session\'s boot()', async () => {
    const { api } = makeWorld();
    await api.go('pokecenter');
    const saved = api.saveState();
    expect(saved.sceneId).toBe('pokecenter');

    const fresh = makeWorld();
    fresh.api.loadState(saved);
    // `hidden` is a panel-only flag (src/travel/index.js) — it must not read as `locked` and bounce the
    // save to the lobby the way an actually-gated destination does (selftest #26).
    expect(fresh.api.boot()).toBe('pokecenter');
  });
});
