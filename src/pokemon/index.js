/**
 * pokemon — species data, party, and the overworld sprite system (ARCHITECTURE §5.5).
 *
 * Species data is a committed snapshot: `public/generated/species.json` holds all 1253
 * sheets in `assets/overworld/` across Gen 1-9, built by `src/pokemon/tools/build-species.js`
 * at build time. Nothing is fetched at runtime beyond that one file.
 *
 * Sprites are billboards drawn out of a runtime atlas by one InstancedMesh (see field.js),
 * so the whole cast costs two draw calls.
 */

import * as THREE from 'three';
import { SpriteField } from './field.js';
import {
  POKEMON_SHEET, TRAINER_SHEET, TEXELS_PER_UNIT,
  pokemonCycle, trainerCycle, frameWorldSize, sheetLayout,
} from './sprites.js';

const TRAINERS = { hero: '/assets/trainer/hero.png', heroine: '/assets/trainer/heroine.png' };

const spriteUrl = (species, shiny) =>
  `/assets/overworld/${typeof species === 'string' ? species : species.name}/${shiny ? 'shiny' : 'normal'}.png`;

export default {
  id: 'pokemon',
  needs: [],
  /** The showcase stands its cast on real ground, so it needs the tile world (§6). */
  showcaseNeeds: ['terrain'],

  async init(ctx) {
    const { log } = ctx;

    // --- species snapshot ---------------------------------------------------
    let table = null;
    try {
      const res = await fetch('/generated/species.json');
      if (res.ok) table = await res.json();
    } catch { /* falls through to the built-in starter set */ }
    if (!Array.isArray(table) || !table.length) {
      log.warn('pokemon: /generated/species.json missing — running on the starter subset. ' +
        'Run `node src/pokemon/tools/build-species.js`.');
      table = (await import('./starter-species.js')).STARTERS;
    }

    /** Dex number -> the base form, so species(25) is Pikachu and not Pikachu-World-Cap. */
    const byId = new Map();
    const byName = new Map();
    for (const s of table) {
      byName.set(s.name, s);
      const held = byId.get(s.id);
      if (!held || (held.form && !s.form)) byId.set(s.id, s);
    }
    const lookup = (k) => (typeof k === 'number' ? byId.get(k) : byName.get(String(k).toLowerCase())) ?? null;

    // --- sprite field -------------------------------------------------------
    const field = new SpriteField(THREE, ctx, { capacity: 384 });
    const party = [];

    /** Resolves a sprite request to an atlas sheet, loading it if this is the first time. */
    async function prepare(requests) {
      const list = [];
      for (const r of [].concat(requests)) {
        if (r.trainer) list.push({ kind: 'trainer', url: TRAINERS[r.trainer] ?? TRAINERS.hero });
        else {
          const s = typeof r.species === 'object' ? r.species : lookup(r.species ?? r);
          if (!s) { log.warn(`pokemon.prepare: no species "${r.species ?? r}"`); continue; }
          list.push({ kind: 'pokemon', url: spriteUrl(s, r.shiny) });
        }
      }
      if (!list.length) return field.atlas.stats();
      return field.prepare(list);
    }

    const api = {
      // --- data (§5.5) ------------------------------------------------------
      species: lookup,
      all: () => table,
      byGen: (n) => table.filter((s) => s.gen === n),
      byType: (t) => table.filter((s) => s.types.includes(t)),
      count: () => table.length,
      generations: () => [...new Set(table.map((s) => s.gen))].sort((a, b) => a - b),
      /** Base forms only — 1025 of the 1253 sheets are a distinct species. */
      baseForms: () => table.filter((s) => !s.form),

      // --- sprite description (§5.5) ---------------------------------------
      spriteUrl: (species, { shiny = false } = {}) => spriteUrl(species, shiny),
      /** Kept for callers written against the seed API. */
      spriteSheet: (species, { shiny = false } = {}) => spriteUrl(species, shiny),

      /**
       * Everything a caller needs to draw one species itself.
       * @returns {Promise<{atlas:THREE.Texture, size:object, frames:object}|null>}
       */
      async sprite(species, { shiny = false } = {}) {
        const s = typeof species === 'object' ? species : lookup(species);
        if (!s) return null;
        const url = spriteUrl(s, shiny);
        await prepare([{ species: s, shiny }]);
        const key = SpriteField.key('pokemon', url);
        const layout = field.atlas.layout(key);
        if (!layout) return null;
        const rects = (dir) => pokemonCycle(dir).map((i) => {
          const out = new Float32Array(4);
          field.atlas.rect(key, i, out);
          return { u: out[0], v: out[1], w: out[2], h: out[3] };
        });
        const frames = [rects(0), rects(1), rects(2), rects(3)];
        // Indexable by core/dir.js number *and* by name, so both readings of §5.5 work.
        Object.assign(frames, { south: frames[0], west: frames[1], north: frames[2], east: frames[3] });
        return {
          atlas: field.atlas.texture,
          size: { frame: layout.frame, sheet: s.sheet ?? null, world: frameWorldSize(layout.frame, ctx.config.cameraPitch) },
          frames,
        };
      },

      // --- the sprite field -------------------------------------------------
      sprites: {
        prepare,
        /**
         * @param {object} spec  `{ species | trainer, shiny, x, y, z, dir, gait, phase, scale }`
         *   Position is world space, at the sprite's feet. `dir` is a core/dir.js direction.
         * @returns {Promise<number>} actor id, 0 on failure
         */
        async spawn(spec) {
          await prepare([spec]);
          const url = spec.trainer ? (TRAINERS[spec.trainer] ?? TRAINERS.hero)
            : spriteUrl(typeof spec.species === 'object' ? spec.species : lookup(spec.species), spec.shiny);
          return field.add({ ...spec, kind: spec.trainer ? 'trainer' : 'pokemon', who: spec.trainer, url });
        },
        set: (id, patch) => field.set(id, patch),
        get: (id) => field.get(id),
        remove: (id) => field.remove(id),
        clear: () => field.clear(),
        count: () => field.count(),
        stats: () => ({ ...field.atlas.stats(), actors: field.count() }),
        /**
         * Animation phase from distance walked, in tiles. Two cycle phases per tile keeps
         * the feet locked to the grid instead of sliding.
         */
        phaseFor: (tiles) => Math.floor(tiles * 2),
        field,
      },

      // --- sheet contracts, for anything that needs the raw layout ----------
      SHEET: { pokemon: POKEMON_SHEET, trainer: TRAINER_SHEET, texelsPerUnit: TEXELS_PER_UNIT },
      cycles: { pokemon: pokemonCycle, trainer: trainerCycle },
      trainers: () => Object.keys(TRAINERS),
      sheetLayout,

      // --- party (§5.5) -----------------------------------------------------
      party: () => party.slice(),
      lead: () => party[0] ?? null,
      setLead(i) {
        if (!party[i]) return;
        const [p] = party.splice(i, 1);
        party.unshift(p);
        ctx.bus.emit('party:leadChanged', { instanceId: p.instanceId, species: p.species.name });
      },
      addToParty(inst) {
        if (!inst || party.length >= 6) return false;
        party.push(inst);
        if (party.length === 1) ctx.bus.emit('party:leadChanged', { instanceId: inst.instanceId, species: inst.species.name });
        return true;
      },
      swap(i, j) { if (party[i] && party[j]) [party[i], party[j]] = [party[j], party[i]]; },

      createInstance({ species, level = 5, shiny = false, seed = 0 }) {
        const s = typeof species === 'object' ? species : lookup(species);
        if (!s) return null;
        const rng = ctx.rng.fork(`instance/${s.name}/${seed}`);
        return {
          instanceId: `${s.name}-${seed}-${level}`,
          species: s, level, shiny,
          hp: 1, exp: 0,
          ivs: { hp: rng.int(0, 31), atk: rng.int(0, 31), def: rng.int(0, 31), spa: rng.int(0, 31), spd: rng.int(0, 31), spe: rng.int(0, 31) },
        };
      },

      dispose() { field.dispose(); },
    };

    return api;
  },

  frame(dt, alpha, ctx) {
    ctx.get('pokemon').sprites?.field?.update();
  },

  async showcase(mode, ctx) {
    const { showcasePokemon } = await import('./showcase.js');
    return showcasePokemon(mode, ctx);
  },
};
