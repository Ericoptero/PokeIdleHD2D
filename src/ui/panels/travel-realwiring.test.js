/**
 * The travel panel's `hidden` filter, wired to the REAL `travel` module rather than a
 * hand-authored destinations array.
 *
 * `src/ui/panels/travel.test.js` proves `rows()` drops a row that
 * ALREADY carries `hidden: true` in a literal array it wrote by hand — it never calls the real
 * `travel/index.js`, so it cannot catch the two halves disagreeing with each other (e.g.
 * `travel/index.js`'s `destinations()` forgetting to set `hidden`, or spelling the id
 * differently than `pokecenter/index.js`'s `MAP_ID`). This wires the actual `travel` module
 * (imported the way a seam allows — another module's own `index.js`, `tools/seams/run.js`
 * rule 2 — and driven through `init(stubCtx)`, not a deep import of its internals) to the real
 * panel, so what is asserted is the two real pieces of code agreeing.
 *
 * Proven able to fail: on the previous tree `travel.destinations()` carries no `pokecenter`
 * row at all (hidden or otherwise), so `all.find(...)` is `undefined` and the first assertion
 * throws on `pc?.hidden`.
 */
import { describe, it, expect } from 'vitest';
import travel from '../../travel/index.js';
import { makeTravel } from './travel.js';

function makeTravelApi({ trainerLevel = 5 } = {}) {
  const modules = {
    city: { enter: async () => {}, formation: () => ({}) },
    pokecenter: { enter: async () => {}, formation: () => ({}) },
    hunts: {
      list: () => [
        { id: 'meadow', name: 'Verdant Meadow', requiredLevel: 0 },
        { id: 'forest', name: 'Whisper Wood', requiredLevel: 5 },
      ],
      enter: async () => {},
    },
    economy: { trainer: () => ({ level: trainerLevel }) },
    encounter: { active: () => false, cancel: () => {} },
    simulation: { halt: () => {} },
    offline: null,
  };
  const ctx = {
    bus: { emit: () => {}, on: () => () => {} },
    config: { scene: null, showcase: null },
    log: { info() {}, warn() {}, error() {} },
    get: (id) => modules[id] ?? { __missing: true },
  };
  return travel.init(ctx);
}

describe('the travel panel wired to the real travel module', () => {
  it('the real destinations() marks pokecenter hidden, and the real rows() drops exactly that row', () => {
    const travelApi = makeTravelApi();
    const all = travelApi.destinations();
    const pc = all.find((d) => d.id === 'pokecenter');
    expect(pc?.hidden, 'the real travel module marks the Center hidden').toBe(true);

    const app = { ctx: { get: (id) => (id === 'travel' ? travelApi : { __missing: true }) } };
    const panel = makeTravel(app);
    const ids = panel.rows().map((r) => r.id);
    expect(ids).not.toContain('pokecenter');
    // Exactly the non-hidden set, in the same order — not a coincidental subset.
    expect(ids).toEqual(all.filter((d) => !d.hidden).map((d) => d.id));
    expect(ids).toEqual(['demo-city', 'hunt-meadow', 'hunt-forest']);
  });

  it('go("pokecenter") — what the door listener calls — is untouched by the panel filter', async () => {
    // `rows()` hides the row from the LIST; it must not have been implemented by filtering
    // `go()` itself, which is the door listener's only way in.
    const travelApi = makeTravelApi();
    expect(await travelApi.go('pokecenter')).toBe(true);
    expect(travelApi.current()?.id).toBe('pokecenter');
  });
});
