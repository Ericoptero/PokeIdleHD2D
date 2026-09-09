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
import * as INST from './instance.js';
import { makeEvolution, TOTAL_S as EVOLVE_SECONDS } from './evolve-anim.js';

/** Save slice version. `loadState` migrates forward and refuses a newer one (§5). */
const SAVE_VERSION = 1;
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
  /**
   * The showcase stands its cast on real ground, so it needs the tile world (§6) — and
   * `mode=levelup` drives the instance model, which reaches `battle` through `ctx.get`.
   * Without it here that mode gets the registry's null object and mints Pokemon with no
   * moves, which is a correct degradation in the game and a useless picture in a showcase.
   */
  showcaseNeeds: ['terrain', 'battle', 'economy'],

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

    /**
     * `battle` is reached lazily and through `ctx.get`, never declared in `needs`.
     *
     * The engine supplies the stat formula, the growth curves and the move table — but a
     * quarantined engine must cost the game its *moves*, not its *sprites*. `pokemon` failing
     * takes the overworld down with it, and §2.1's whole point is that one broken module does
     * not cascade. Lazily, because the starters are minted long after init and `battle` may
     * still be loading its 330 KB of data when this module comes up.
     */
    const battle = () => ctx.get('battle');

    /** Monotone, so `instanceId` is unique and is never derived from a level (DECISIONS #61). */
    let ordinal = 0;

    /** Ids already toasted "can evolve", so the news is broken once and not once a second. */
    const announced = new Set();

    /** Evolution flashes in flight, keyed by actor id. Stepped from `lateFrame`. */
    const evolutions = new Map();

    /**
     * Advances every flash in real seconds.
     *
     * Real time, not sim time: this is presentation and must not change what the world does.
     * It runs from `lateFrame`, before `field.update()`, so the last write of the frame is the
     * animation's — `simulation` poses walkers on `frame` and its patch carries position and
     * gait but never `key` or `scale`, so the two never fight over the same field.
     */
    function stepEvolutions(dt) {
      if (!evolutions.size) return;
      for (const [id, anim] of [...evolutions]) {
        if (!anim.step(dt)) {
          evolutions.delete(id);
          anim.resolve?.(true);
        }
      }
    }

    /** How many of an item the bag holds. 0 when the ledger is quarantined, which reads as
     *  "you cannot afford it" rather than as a crash. */
    const bagCount = (id) => {
      const eco = ctx.get('economy');
      return INST.isLive(eco) && typeof eco.count === 'function' ? eco.count(id) : 0;
    };

    /**
     * Whether the ledger actually stocks an item.
     *
     * Showdown names nine Gen 8/9 evolution items this game does not sell; asking for one
     * would make those lines unreachable. `evolution.js` drops an unknown id rather than
     * inventing shop stock, and this is how it finds out. A quarantined `economy` answers
     * "yes" to everything, which keeps the *requirement* honest even when the bag is gone.
     */
    const isItem = (id) => {
      const eco = ctx.get('economy');
      return INST.isLive(eco) && typeof eco.item === 'function' ? !!eco.item(id) : true;
    };

    /** An item's display name, for a refusal a player can act on. */
    const itemName = (id) => {
      const eco = ctx.get('economy');
      const def = INST.isLive(eco) && typeof eco.item === 'function' ? eco.item(id) : null;
      return def?.name ?? id;
    };

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

    /** A party member by id. The party is two to six entries; a Map would be ceremony. */
    const find = (instanceId) => party.find((p) => p.instanceId === instanceId) ?? null;

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
         * Plays the evolution flash on one staged actor, and resolves when it lands.
         *
         * The caller owns the actor — `simulation` stages the party and knows which slot the
         * lead is in — so the id comes in rather than being hunted for. Both sheets are
         * prepared here because the new form's is not in the atlas until somebody asks for it,
         * and an animation that alternates onto a sheet that is not loaded draws the wrong
         * Pokemon for half its length.
         *
         * Resolves rather than rejecting when it cannot run: a missing sheet must cost the
         * moment its flourish, not cost the player their evolution.
         */
        async playEvolution({ actorId, from, to, shiny = false } = {}) {
          const a = typeof from === 'object' ? from : lookup(from);
          const b = typeof to === 'object' ? to : lookup(to);
          if (!actorId || !a || !b || !field.get(actorId)) return false;

          await prepare([{ species: a, shiny }, { species: b, shiny }]);
          const sheet = (s) => {
            const key = SpriteField.key('pokemon', spriteUrl(s, shiny));
            const layout = field.atlas.layout(key);
            return layout ? { key, frameTexels: layout.frame } : null;
          };
          const oldSheet = sheet(a);
          const newSheet = sheet(b);
          if (!oldSheet || !newSheet) {
            log.warn(`pokemon: no atlas sheet for the evolution ${a.name} -> ${b.name}`);
            return false;
          }

          // One at a time per actor: a second evolution landing on the same sprite would
          // leave two animations fighting over `key` and the loser's last write would win.
          evolutions.get(actorId)?.finish();
          const anim = makeEvolution(field, actorId, oldSheet, newSheet);
          return new Promise((resolve) => {
            evolutions.set(actorId, Object.assign(anim, { resolve }));
          });
        },
        /** Seconds one evolution takes, so a caller can time a toast against it. */
        evolutionSeconds: EVOLVE_SECONDS,
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
        /** Driven by the descriptor's `lateFrame`; not part of the §5.5 surface. */
        _stepEvolutions: stepEvolutions,
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

      createInstance({ species, level = 5, shiny = false, seed = 0, ivs = null }) {
        const s = typeof species === 'object' ? species : lookup(species);
        if (!s) return null;
        const rng = ctx.rng.fork(`instance/${s.name}/${seed}`);
        return INST.makeInstance({ species: s, level, shiny, ivs, ordinal: ordinal++, rng }, battle());
      },

      // --- levels, moves and evolution (§5.5, DECISIONS #61) ----------------

      /**
       * The seam `idle/index.js:213` has been calling into empty space since it was written.
       *
       * `source` is what makes "the hunt is the only way to evolve" (§0) enforceable at ONE
       * point: experience is granted everywhere, and only a hunt is allowed to act on the
       * evolution it unlocks.
       */
      grantExp(instanceId, amount, { source = 'hunt' } = {}) {
        const inst = find(instanceId);
        if (!inst) return null;
        const report = INST.grantExp(inst, amount, { battle: battle(), lookup, count: bagCount, isItem });
        if (report.levelled) {
          ctx.bus.emit('pokemon:levelled', {
            instanceId, from: report.from, to: report.to, learned: report.learned,
          });
          // An evolution the player can afford is worth interrupting for once, and exactly
          // once — the toast names the button rather than pressing it.
          if (report.pending?.ready && !announced.has(instanceId)) {
            announced.add(instanceId);
            ctx.bus.emit('ui:toast', {
              text: `${inst.species.display ?? inst.species.name} can evolve — open PARTY`,
              kind: 'good',
            });
          }
          if (!report.pending?.ready) announced.delete(instanceId);
        }
        report.source = source;
        return report;
      },

      /** Grants to the whole party at once — what a won battle actually pays. */
      grantPartyExp(amount, opts = {}) {
        return party.filter((p) => p.hp > 0).map((p) => api.grantExp(p.instanceId, amount, opts));
      },

      /**
       * The evolution this Pokemon is closest to, priced, or `null`.
       *
       * Everything the button needs: the level it wants, the materials, how many of each the
       * bag actually holds, what is still missing, and whether it can be pressed. Pure — asking
       * changes nothing, which is what lets the panel call it every frame it redraws.
       */
      canEvolve(instanceId) {
        const inst = find(instanceId);
        if (!inst) return null;
        const pending = INST.evolutionFor(inst, lookup, { count: bagCount, isItem });
        if (!pending) return null;
        return {
          to: pending.to.name, display: pending.display, type: pending.type,
          level: pending.level, have: inst.level, materials: pending.materials,
          missing: pending.missing, ready: pending.ready,
        };
      },

      /** Every route this species has, priced. A branching line shows the player all eight. */
      evolutions(instanceId) {
        const inst = find(instanceId);
        if (!inst) return [];
        return INST.evolutionOptions(inst, lookup, { count: bagCount, isItem }).map((r) => ({
          to: r.to.name, display: r.display, type: r.type, level: r.level,
          materials: r.materials, missing: r.missing, ready: r.ready,
        }));
      },

      /**
       * Evolves, **and only ever because a player asked**.
       *
       * There is no automatic path into this function any more: `grantExp` reports a pending
       * evolution and stops (DECISIONS #62). It costs a level and a pile of materials that can
       * only come out of a hunt, and it spends them through `economy`'s published API — this
       * module owns the creature, the ledger owns the bag, and neither reaches into the other.
       *
       * Refuses, and says which of the three reasons it is: no route, too low, or short of
       * materials. A silent `null` would leave a greyed-out button with nothing to explain it.
       */
      evolve(instanceId, { to = null } = {}) {
        const inst = find(instanceId);
        if (!inst) return { ok: false, why: 'no such Pokémon' };

        const options = INST.evolutionOptions(inst, lookup, { count: bagCount, isItem });
        if (!options.length) return { ok: false, why: 'it does not evolve' };
        // No named route and nothing affordable: fall back to the one it is CLOSEST to, so the
        // refusal below can name the actual shortfall. Answering "nothing it can evolve into"
        // when the truth is "six nuggets short" is the greyed-out button with no explanation
        // that this whole panel exists to avoid.
        const pick = to
          ? options.find((r) => r.to.name === to)
          : (options.find((r) => r.ready) ?? INST.evolutionFor(inst, lookup, { count: bagCount, isItem }));
        if (!pick) return { ok: false, why: `it cannot become ${to}` };
        if (inst.level < pick.level) {
          return { ok: false, why: `needs level ${pick.level}`, requirement: pick };
        }
        if (pick.missing.length) {
          const short = pick.missing.map((m) => `${m.n - m.have}× ${itemName(m.id)}`).join(', ');
          return { ok: false, why: `still needs ${short}`, requirement: pick };
        }

        // Spend first, then transform: a `take` that fails must not leave an evolved Pokémon
        // that was never paid for.
        const eco = ctx.get('economy');
        if (INST.isLive(eco) && typeof eco.take === 'function') {
          for (const m of pick.materials) {
            if (!eco.take(m.id, m.n)) return { ok: false, why: `the bag would not part with ${itemName(m.id)}` };
          }
        }

        const done = INST.evolveTo(inst, pick.to, battle());
        announced.delete(instanceId);
        ctx.bus.emit('pokemon:evolved', { ...done, spent: pick.materials });
        ctx.bus.emit('ui:toast', {
          text: `${inst.species.display ?? done.from} evolved into ${pick.display}!`, kind: 'good',
        });
        return { ok: true, ...done, spent: pick.materials };
      },

      levelUp(instanceId) {
        const inst = find(instanceId);
        if (!inst || inst.level >= 100) return null;
        const b = battle();
        const growth = inst.species.growthRate ?? 'medium';
        const need = INST.isLive(b) ? b.expToLevel(growth, inst.level + 1) : (inst.level + 1) ** 3;
        return api.grantExp(instanceId, Math.max(1, need - inst.exp), { source: 'debug' });
      },

      refreshMoves: (instanceId) => {
        const inst = find(instanceId);
        return inst ? INST.refreshMoves(inst, battle()) : null;
      },
      setPriority(instanceId, moveIds) {
        const inst = find(instanceId);
        if (!inst) return false;
        inst.priority = (moveIds ?? []).filter((m) => typeof m === 'string');
        const b = battle();
        if (INST.isLive(b) && typeof b.setPriority === 'function') b.setPriority(instanceId, inst.priority);
        INST.refreshMoves(inst, b);
        return true;
      },

      heal(instanceId, opts) {
        if (instanceId === 'all' || instanceId == null) { party.forEach((p) => INST.heal(p, opts)); return true; }
        const inst = find(instanceId);
        return inst ? INST.heal(inst, opts) : null;
      },
      damage(instanceId, n) {
        const inst = find(instanceId);
        return inst ? INST.damage(inst, n) : null;
      },
      /** The party member that can still fight, or null — what a faint swaps to. */
      firstConscious: () => party.find((p) => p.hp > 0) ?? null,
      instance: (instanceId) => find(instanceId) ?? null,

      // --- the save seam (§5) ------------------------------------------------
      saveState: () => ({ v: SAVE_VERSION, ordinal, party: party.map(INST.serialize) }),
      /**
       * Silent by contract (§5): no `party:leadChanged`, no toast. Derived state — stats,
       * maxHp, the move list — is rebuilt from the species and the level, never trusted.
       */
      loadState(value) {
        if (!value || typeof value !== 'object') return false;
        if (Number(value.v) > SAVE_VERSION) {
          log.warn(`pokemon: save slice v${value.v} is newer than v${SAVE_VERSION} — not loaded`);
          return false;
        }
        const restored = (value.party ?? [])
          .map((slice) => INST.deserialize(slice, lookup, battle()))
          .filter(Boolean);
        if (!restored.length) return false;
        party.length = 0;
        party.push(...restored.slice(0, 6));
        ordinal = Math.max(Number(value.ordinal) || 0, ...party.map((p) => {
          const n = Number(String(p.instanceId).split('#')[1]);
          return Number.isFinite(n) ? n + 1 : 0;
        }));
        return true;
      },

      dispose() { field.dispose(); },
    };

    return api;
  },

  // `lateFrame`, not `frame`: `field.update()` reads the camera basis to put every sprite on
  // the internal pixel grid, and the camera does not move until after `frame` has run.
  lateFrame(dt, alpha, ctx) {
    const api = ctx.get('pokemon');
    // The flash writes `key` and `scale`; `field.update()` reads them. In that order, once.
    api.sprites?._stepEvolutions?.(dt);
    api.sprites?.field?.update();
  },

  async showcase(mode, ctx) {
    const { showcasePokemon } = await import('./showcase.js');
    return showcasePokemon(mode, ctx);
  },
};
