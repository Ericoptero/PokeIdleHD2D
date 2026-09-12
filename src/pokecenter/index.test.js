/**
 * `pokecenter`'s own state — the save slice and the cure's cooldown gate — driven against the
 * real module (`init(stubCtx)`), not re-derived from `heal.js`'s pure unit test alone
 * (DECISIONS #35: two calls into the same pure function would agree even if both were wrong;
 * this exercises the actual `bus.on('player:interact', …)` listener and the actual
 * `pokemon.reviveAll()` + `restorePp()` calls it makes).
 */
import { describe, it, expect } from 'vitest';
import { makeBus } from '../core/bus.js';
import { HEAL_COOLDOWN_MS } from './heal.js';
import pokecenter from './index.js';

/** A world just real enough to answer `pokecenter`'s questions, built fresh per test. */
function makeWorld({ startMs = 1_000_000, sceneId = 'pokecenter', showcase = null } = {}) {
  let wallMs = startMs;
  const said = [];
  const revived = [];
  const restoredPp = [];
  let party = [
    {
      instanceId: 'p1', hp: 0, maxHp: 20, status: 'psn',
      moves: [{ id: 'tackle', pp: 0, maxPp: 10 }, { id: 'growl', pp: 1, maxPp: 15 }],
    },
    { instanceId: 'p2', hp: 5, maxHp: 18, status: null, moves: [{ id: 'ember', pp: 2, maxPp: 5 }] },
  ];

  const modules = {
    terrain: {
      register: () => {}, draft: () => null, height: () => 0,
      load: async () => ({ spawn: { cx: 6, cz: 8, dir: 2 } }),
    },
    environment: { setBiomePreset: () => {}, setWeather: () => {} },
    simulation: {
      placePlayer: () => {}, setFormation: () => {}, teleport: () => {},
      spawnNpc: () => ({ id: 7 }), removeNpc: () => true,
    },
    pokemon: {
      sprites: { prepare: async () => {} },
      party: () => party,
      reviveAll: () => {
        revived.push(wallMs);
        party = party.map((m) => ({ ...m, hp: m.maxHp, status: null }));
        return party.length;
      },
      restorePp: (instanceId, opts) => {
        restoredPp.push({ instanceId, ...opts });
        party = party.map((m) => (m.instanceId === instanceId
          ? { ...m, moves: m.moves.map((s) => (s.id === opts.moveId ? { ...s, pp: s.maxPp } : s)) }
          : m));
        return 0;
      },
    },
    travel: { current: () => (sceneId ? { id: sceneId } : null) },
    ui: { say: (text, opts) => { said.push({ text, opts }); return true; } },
  };

  const bus = makeBus();
  const ctx = {
    bus,
    config: { showcase, seed: 1337 },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clock: { wallMs: () => wallMs },
    three: { rig: { setFocus: () => {} }, scene: {} },
    get: (id) => modules[id] ?? { __missing: true },
  };

  const api = pokecenter.init(ctx);
  return {
    api, bus, said, revived, restoredPp,
    party: () => party,
    advanceMs: (n) => { wallMs += n; },
  };
}

const interactAtCounter = (bus) => bus.emit('player:interact', {
  cx: 6, cz: 3, dir: 2, facing: { cx: 6, cz: 2 }, tags: ['counter'],
});

describe('pokecenter — the save slice', () => {
  it('saveState() round-trips through loadState()', () => {
    const { api } = makeWorld();
    expect(api.loadState({ v: 1, lastHealMs: 555_000 })).toBe(true);
    expect(api.saveState()).toEqual({ v: 1, lastHealMs: 555_000 });
  });

  it('a fresh module (never loaded) saves lastHealMs: null', () => {
    const { api } = makeWorld();
    expect(api.saveState()).toEqual({ v: 1, lastHealMs: null });
  });

  it('a non-finite lastHealMs is treated as never healed, and the cure is available immediately', () => {
    const { api, bus, revived, said } = makeWorld();
    api.loadState({ v: 1, lastHealMs: NaN });
    expect(api.saveState().lastHealMs).toBeNull();

    interactAtCounter(bus);
    expect(revived, 'a "never healed" load cures on the first visit, no cooldown').toHaveLength(1);
    expect(said.at(-1)?.opts?.speaker).toBe('Nurse Joy');
  });

  it('a missing lastHealMs field is also treated as never healed', () => {
    const { api, bus, revived } = makeWorld();
    api.loadState({ v: 1 });
    interactAtCounter(bus);
    expect(revived).toHaveLength(1);
  });

  it('loadState refuses a non-object value', () => {
    const { api } = makeWorld();
    expect(api.loadState(null)).toBe(false);
    expect(api.loadState('nope')).toBe(false);
  });
});

describe('pokecenter — the cure, against the real player:interact listener', () => {
  it('heals HP, status AND every move slot\'s PP — the difference from every other recovery', () => {
    const { bus, party } = makeWorld();
    interactAtCounter(bus);
    const [a, b] = party();
    expect(a.hp).toBe(a.maxHp);
    expect(a.status).toBeNull();
    expect(a.moves.every((m) => m.pp === m.maxPp), 'every slot topped up, not just the emptiest').toBe(true);
    expect(b.moves.every((m) => m.pp === m.maxPp)).toBe(true);
  });

  it('is a no-op on any tag other than "counter"', () => {
    const { bus, revived } = makeWorld();
    bus.emit('player:interact', { cx: 1, cz: 1, dir: 0, facing: { cx: 1, cz: 2 }, tags: ['bench'] });
    expect(revived).toHaveLength(0);
  });

  it('does nothing outside the room (a stray listener from another scene would be a bug)', () => {
    const { bus, revived } = makeWorld({ sceneId: 'demo-city' });
    interactAtCounter(bus);
    expect(revived).toHaveLength(0);
  });

  it('on cooldown: refuses, and nothing about the party or the stamp changes', () => {
    const { bus, revived, restoredPp, said, party } = makeWorld();
    interactAtCounter(bus);
    expect(revived).toHaveLength(1);
    const restoredCountAfterFirst = restoredPp.length;
    const hpAfterFirst = party().map((m) => m.hp);

    interactAtCounter(bus);
    expect(revived, 'the cure did not run a second time on cooldown').toHaveLength(1);
    expect(restoredPp).toHaveLength(restoredCountAfterFirst);
    expect(party().map((m) => m.hp)).toEqual(hpAfterFirst);
    expect(said.at(-1)?.text?.[0]).not.toEqual(said.at(-2)?.text?.[0]);
  });

  it('the cooldown expires after HEAL_COOLDOWN_MS and the cure works again', () => {
    const { bus, revived, advanceMs } = makeWorld();
    interactAtCounter(bus);
    expect(revived).toHaveLength(1);

    interactAtCounter(bus);
    expect(revived, 'still on cooldown one ms early').toHaveLength(1);

    advanceMs(HEAL_COOLDOWN_MS - 1);
    interactAtCounter(bus);
    expect(revived, 'one ms short of the boundary — still refused').toHaveLength(1);

    advanceMs(1);
    interactAtCounter(bus);
    expect(revived, 'exactly at the boundary — available again').toHaveLength(2);
  });

  it('does not heal at all under a showcase — a showcase stages a frame and never writes state', () => {
    const { bus, revived } = makeWorld({ showcase: 'pokecenter' });
    interactAtCounter(bus);
    expect(revived).toHaveLength(0);
  });
});
