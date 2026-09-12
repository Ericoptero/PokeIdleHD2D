/**
 * `pokemon.reorder(from, to)` splices a party member into a new position.
 * `swap(i, j)` remains a separate operation that emits no event.
 *
 * `init(stubCtx)` on the REAL module rather than a hand-rolled reducer, so a drift between
 * this test and `index.js`'s actual splice cannot happen — the same discipline every other
 * `*.test.js` in this repo follows. Two things the real module needs that vitest's own
 * `environment: 'node'` (vitest.config.js) does not provide, stubbed to the minimum each
 * needs and no further:
 *
 *  - `fetch`, for the committed species snapshot — `selftest.js`'s own stub, copied verbatim.
 *  - `document.createElement('canvas')`, because `SpriteField`'s constructor
 *    (`field.js` `makeBlobTexture`) builds the contact-shadow texture unconditionally, even
 *    though nothing in this file ever spawns a sprite. A plain object with a `getContext('2d')`
 *    that answers the three calls `makeBlobTexture` makes is enough; three.js's own
 *    `CanvasTexture` never inspects the canvas beyond holding a reference to it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng } from '../core/rng.js';
import pokemonModule from './index.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const speciesTable = JSON.parse(readFileSync(join(REPO, 'public', 'generated', 'species.json'), 'utf8'));

beforeAll(() => {
  globalThis.fetch = async (url) => {
    const name = String(url).split('/').pop();
    if (name === 'species.json') return { ok: true, json: async () => speciesTable };
    return { ok: false, json: async () => null };
  };
  if (!globalThis.document) {
    globalThis.document = {
      createElement(tag) {
        if (tag !== 'canvas') throw new Error(`stub document: unexpected element <${tag}>`);
        return {
          width: 0, height: 0,
          getContext: () => ({
            fillStyle: null,
            createRadialGradient: () => ({ addColorStop() {} }),
            fillRect() {},
          }),
        };
      },
    };
  }
});

/** A fresh `ctx` per test — `party` is module-scope inside `init`'s closure, so a fresh
 *  `pokemon.init(ctx)` is the only way to get an empty party to build a fixture on. */
async function makeParty(names) {
  const emitted = [];
  const ctx = {
    bus: {
      emit(type, payload) { emitted.push({ type, payload }); },
      on: () => () => {},
    },
    config: { cameraPitch: 45, seed: 1337 },
    log: { info() {}, warn() {}, error() {} },
    rng: makeRng(1337, 'root/pokemon-reorder-test'),
    get: () => undefined,
    three: { scene: { add() {} } },
  };
  const pokemon = await pokemonModule.init(ctx);
  names.forEach((species, i) => {
    const inst = pokemon.createInstance({ species, level: 5, seed: i });
    expect(inst, `fixture species "${species}" must mint`).not.toBeNull();
    expect(pokemon.addToParty(inst)).toBe(true);
  });
  emitted.length = 0; // only `reorder`'s own emissions matter to the assertions below
  return { pokemon, emitted };
}

const SPECIES = ['oshawott', 'snivy', 'tepig', 'pikachu'];

describe('pokemon.reorder(from, to)', () => {
  it('moves the third member to the front and emits party:leadChanged naming it', async () => {
    const { pokemon, emitted } = await makeParty(SPECIES);
    const before = pokemon.party().map((p) => p.instanceId);
    const moved = before[2];

    pokemon.reorder(2, 0);

    expect(pokemon.party().map((p) => p.instanceId)).toEqual([moved, before[0], before[1], before[3]]);
    expect(emitted).toEqual([{ type: 'party:leadChanged', payload: { instanceId: moved, species: 'tepig' } }]);
  });

  it('a move that never touches slot 0 emits nothing', async () => {
    const { pokemon, emitted } = await makeParty(SPECIES);
    const before = pokemon.party().map((p) => p.instanceId);

    pokemon.reorder(1, 3);

    expect(pokemon.party()[0].instanceId).toBe(before[0]);
    expect(emitted).toEqual([]);
  });

  it('an out-of-range index is a no-op, mirroring setLead\'s and swap\'s own guard style', async () => {
    const { pokemon, emitted } = await makeParty(SPECIES);
    const before = pokemon.party().map((p) => p.instanceId);

    pokemon.reorder(9, 0);
    pokemon.reorder(0, 9);
    pokemon.reorder(-1, 2);

    expect(pokemon.party().map((p) => p.instanceId)).toEqual(before);
    expect(emitted).toEqual([]);
  });
});
