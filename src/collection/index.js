/**
 * collection — the dex, the boxes, and the organisation on top of them (ARCHITECTURE §5.10).
 *
 * Pure data plus events. This module renders nothing: it listens to `encounter:started` and
 * `catch:succeeded`, keeps the record straight, and emits `collection:added`. Everything
 * visible lives in `ui` (or, for the gauntlet, in `showcase.js`).
 *
 *   dex.js       what has been seen and caught; completion per generation and per type
 *   boxes.js     960 real slots, and what happens when they run out
 *   sorting.js   nine total orderings and the duplicate-release rules
 *   selftest.js  the invariants, runnable in Node with no browser
 *
 * ### Four seams worth understanding
 *
 * **A catch arrives as two events, and often as only one.** `encounter:started` carries the
 * level, the biome and the shiny flag; `catch:succeeded` carries only
 * `{ instanceId, species, shiny }` (ARCHITECTURE §4). So the last started encounter is
 * remembered and consumed by a matching catch — but a bare `catch:succeeded` with no
 * encounter before it is normal traffic, not an error: `economy`'s showcase emits six of
 * them, and `automation` will too. The unpaired path fills in a default level and is
 * otherwise identical.
 *
 * **IVs are derived, not invented.** `catch:succeeded` carries no stats, and this module
 * needs them for the best-IV column, for sorting and for the release rules. They come from
 * `ctx.rng.fork('collection/iv/<species>/<ordinal>')` — a stream keyed to the catch's
 * ordinal, so the same seed and the same event order give the same Pokémon every time, and
 * so *this* module's rolls can never perturb `encounter`'s (§2.5). When the payload already
 * carries a real instance's `ivs`, those win.
 *
 * **`instanceId` is not unique and cannot be trusted as a key.** `encounter` emits the
 * species' dex number as the instance id, so every Pikachu you ever catch arrives as `25`.
 * Storage is keyed by a `uid` minted here — `<species>#<ordinal>` — which is unique by
 * construction and stable across a save. The bus id is kept alongside it and is still what
 * `collection:added` reports, because that is the contract §4 fixes.
 *
 * **Releasing pays, but only through the published API.** `economy.release(instance)`
 * appraises and credits money and shards. It is called through `ctx.get`, guarded by a
 * liveness check — the registry's null object answers `typeof api.release === 'function'`
 * with `true` even for a quarantined module, so "does it have the method" is not a question
 * worth asking (§2.1). `economy` is deliberately *not* in `needs`: §5.10 fixes those at
 * `['pokemon']`, and a Pokédex that refuses to work because the shop is down would be a
 * worse module than one that simply does not pay out.
 */

import { makeDex, ivTotal, ivPct, ivGrade, IV_KEYS, IV_TOTAL_MAX } from './dex.js';
import { makeBoxes, BOX_CAPACITY, BOX_COLS, BOX_ROWS, DEFAULT_BOXES, WALLPAPERS } from './boxes.js';
import { sortEntries, groupBySpecies, planDuplicateRelease, SORT_MODES, SORT_IDS, KEEP_RULES } from './sorting.js';
import { reportSelfTest } from '../core/log.js';

/** Save slice version. Bumped when the shape changes; `loadState` migrates forward. */
const SAVE_VERSION = 1;
/** Level used when a catch arrives with no encounter to pair it with. */
const FALLBACK_LEVEL = 5;

/** The registry's null object answers every property with a function — this is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/** Live handle, so the descriptor's `dispose()` can unhook the bus listeners. */
let live = null;

export default {
  id: 'collection',
  needs: ['pokemon'],
  /**
   * Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). `economy`
   * is here and *not* in `needs` for a reason: §5.10 fixes the dependencies at
   * `['pokemon']`, but the showcase quotes what a release rule would pay, and an appraisal
   * of ₽0 because the ledger was never booted would be a misleading picture rather than an
   * honest one.
   */
  showcaseNeeds: ['city', 'terrain', 'economy'],

  init(ctx) {
    const { bus, clock, config, log } = ctx;
    const pokemon = ctx.get('pokemon');

    const table = (isLive(pokemon) && typeof pokemon.all === 'function' ? pokemon.all() : null) ?? [];
    if (!table.length) {
      log.warn('collection: pokemon.all() gave no species — the dex will count what it sees ' +
        'but cannot report completion until the species snapshot exists');
    }

    const dex = makeDex({
      table,
      // A species name we do not recognise is a data problem worth surfacing, but it is a
      // *handled* one: the record is kept under the raw key. §7 counts console errors, so
      // behaving correctly must not cost us the budget.
      onUnknown: (key) => log.warn(`collection: unknown species "${key}" — recorded under its raw key`),
    });
    const boxes = makeBoxes({ count: DEFAULT_BOXES, capacity: BOX_CAPACITY });

    /** Monotone counter across everything this module records. The determinism anchor. */
    let ordinal = 0;
    /** How many catches had nowhere to go. `automation` can watch this to start releasing. */
    let overflow = 0;
    /** Suppresses toasts during a bulk import (a load, or the showcase's scripted session). */
    let quiet = false;
    /** The last `encounter:started`, waiting for its `catch:succeeded`. */
    let pending = null;

    const now = () => +(clock?.simTime ?? 0);
    const speciesOf = (key) => (isLive(pokemon) && typeof pokemon.species === 'function'
      ? pokemon.species(key) : null) ?? dex.sheet(key);

    // ---------------------------------------------------------------- entries

    /**
     * Builds a storage entry. Everything the box screen, the sort comparators and the
     * release rules need is resolved here, once, so nothing downstream has to re-look-up a
     * species on every frame.
     */
    function makeEntry(spec) {
      const key = String(spec.species?.name ?? spec.species ?? '').toLowerCase();
      const sheet = typeof spec.species === 'object' && spec.species?.name ? spec.species : speciesOf(key);
      const ord = spec.ordinal ?? ordinal++;
      const level = Math.max(1, Math.round(Number(spec.level) || FALLBACK_LEVEL));
      const ivs = normaliseIvs(spec.ivs) ?? rollIvs(key, ord);
      const total = ivTotal(ivs);
      return {
        uid: spec.uid ?? `${key}#${ord}`,
        instanceId: spec.instanceId ?? `${key}-${ord}`,
        species: key,
        dexId: sheet?.id ?? null,
        display: sheet?.display ?? key.replace(/(^|[-_])(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase()),
        form: sheet?.form ?? null,
        gen: sheet?.gen ?? null,
        types: sheet?.types ?? [],
        bst: sheet?.bst ?? 0,
        level,
        shiny: !!spec.shiny,
        ivs,
        ivTotal: total,
        ordinal: ord,
        simTime: Number.isFinite(spec.simTime) ? spec.simTime : now(),
        biome: spec.biome ?? null,
        ball: spec.ball ?? null,
        origin: spec.origin ?? 'wild',
        nickname: spec.nickname ?? null,
        favourite: !!spec.favourite,
        box: -1, slot: -1,
      };
    }

    function normaliseIvs(ivs) {
      if (!ivs || typeof ivs !== 'object') return null;
      const out = {};
      let any = false;
      for (const k of IV_KEYS) {
        const v = Number(ivs[k]);
        if (Number.isFinite(v)) { any = true; out[k] = Math.max(0, Math.min(31, Math.round(v))); }
        else out[k] = 0;
      }
      return any ? out : null;
    }

    /** A stream per catch, so call order in this module cannot perturb any other (§2.5). */
    function rollIvs(key, ord) {
      const rng = ctx.rng.fork(`collection/iv/${key}/${ord}`);
      const out = {};
      for (const k of IV_KEYS) out[k] = rng.int(0, 31);
      return out;
    }

    /**
     * The one path a Pokémon takes into this module. Records the dex, finds a slot, and
     * announces it.
     *
     * @returns {{entry:Object, stored:boolean, isNewSpecies:boolean, at:{box,slot}|null}}
     */
    function intake(spec, { announce = true } = {}) {
      const entry = makeEntry(spec);
      const at = boxes.deposit(entry);
      const stored = !!at;
      if (!stored) overflow++;
      const { isNewSpecies } = dex.add(entry, { stored });

      // The bus spy keeps only the last 256 events (§2.3), so a bulk import of several
      // hundred Pokémon would push every other event out of the screenshot log. The normal
      // path always announces; only an explicit bulk import may opt out.
      if (announce) bus.emit('collection:added', { instanceId: entry.instanceId, isNewSpecies });

      if (!quiet) {
        if (!stored) {
          bus.emit('ui:toast', { text: `Boxes are full — ${entry.display} had nowhere to go`, kind: 'warn' });
        } else if (entry.shiny) {
          bus.emit('ui:toast', { text: `★ Shiny ${entry.display} caught!`, kind: 'good' });
        } else if (isNewSpecies) {
          const c = dex.completion();
          bus.emit('ui:toast', { text: `${entry.display} added to the dex — ${c.caught}/${c.total}`, kind: 'good' });
        }
      }
      return { entry, stored, isNewSpecies, at };
    }

    // ------------------------------------------------------------- resolution

    /** Accepts a uid, an instance id, an entry, or anything carrying either. */
    function resolve(ref) {
      if (!ref) return null;
      if (typeof ref === 'object') {
        if (ref.uid && boxes.has(ref.uid)) return boxes.find(ref.uid);
        return resolve(ref.instanceId ?? ref.uid ?? null);
      }
      const direct = boxes.find(String(ref));
      if (direct) return direct;
      // `instanceId` is not unique (see the header), so a lookup by it answers with the
      // first match in box order — which is the one a box screen would have shown.
      for (const e of boxes.all()) if (e.instanceId === String(ref)) return e;
      return null;
    }

    const ownedOf = (species) => boxes.all().filter((e) => e.species === species);

    // ---------------------------------------------------------------- release

    /**
     * Takes one out of storage for good.
     * @param {*} ref
     * @param {{credit?:boolean, reason?:string}} [opts]  `credit:false` lets `automation`
     *   batch its own payout instead of paying per Pokémon.
     * @returns {{entry:Object, value:{money:number, shards:number}}|null}
     */
    function releaseOne(ref, { credit = true } = {}) {
      const entry = resolve(ref);
      if (!entry) return null;
      boxes.take(entry.uid);
      dex.remove(entry, ownedOf(entry.species));

      let value = { money: 0, shards: 0 };
      if (credit) {
        const economy = ctx.get('economy');
        if (isLive(economy) && typeof economy.release === 'function') {
          // economy appraises from level, shiny and the species' base stats, so it gets the
          // shape it documents rather than our storage entry.
          const sheet = speciesOf(entry.species);
          value = economy.release({
            instanceId: entry.instanceId, level: entry.level, shiny: entry.shiny,
            species: sheet ?? { name: entry.species, baseStats: {} },
          }) ?? value;
        }
      }
      return { entry, value };
    }

    // ------------------------------------------------------------------- bus

    const off = [
      bus.on('encounter:started', (p) => {
        const key = String(p?.species ?? '').toLowerCase();
        if (!key) return;
        dex.see(key, { shiny: !!p?.shiny, ordinal: ordinal++, simTime: now() });
        pending = { species: key, level: Number(p?.level) || FALLBACK_LEVEL, shiny: !!p?.shiny, biome: p?.biome ?? null };
      }),

      bus.on('catch:succeeded', (p) => {
        const key = String(p?.species ?? '').toLowerCase();
        if (!key) return;
        // The encounter that was just running, if this is its catch. A bare catch with no
        // encounter before it (or for a different species) simply does not pair.
        const enc = pending && pending.species === key ? pending : null;
        pending = null;
        intake({
          species: key,
          instanceId: p?.instanceId ?? null,
          shiny: p?.shiny ?? enc?.shiny ?? false,
          level: enc?.level ?? FALLBACK_LEVEL,
          biome: enc?.biome ?? null,
          ivs: p?.ivs ?? p?.instance?.ivs ?? null,
          ball: p?.ball ?? null,
          origin: 'wild',
        });
      }),
    ];

    // ------------------------------------------------------------------- api

    /**
     * Public boxes. Each box is a **sparse array of `capacity` slots** (`null` where empty)
     * that also carries `index`, `name`, `wallpaper` and `count`, so both readings work:
     * `boxes()[0][3]` is the fourth slot and `boxes()[0].name` is the box's name.
     */
    function publicBoxes() {
      return boxes.raw().map((b) => {
        const arr = b.slots.slice();
        arr.index = b.index;
        arr.name = b.name;
        arr.wallpaper = b.wallpaper;
        arr.capacity = boxes.capacity;
        arr.count = b.slots.reduce((n, e) => n + (e ? 1 : 0), 0);
        // A convenience alias so `box.slots[3]` reads as well as `box[3]`. Non-enumerable so
        // the self-reference can never be walked by a structured clone or a deep copy.
        Object.defineProperty(arr, 'slots', { value: arr, enumerable: false });
        return arr;
      });
    }

    function summary() {
      const c = dex.completion();
      const stored = boxes.all();
      const bs = boxes.stats();
      let shinyOwned = 0, ivSum = 0, levelSum = 0, highest = 0, favourites = 0;
      const perSpecies = new Map();
      for (const e of stored) {
        if (e.shiny) shinyOwned++;
        if (e.favourite) favourites++;
        ivSum += e.ivTotal;
        levelSum += e.level;
        if (e.level > highest) highest = e.level;
        perSpecies.set(e.species, (perSpecies.get(e.species) ?? 0) + 1);
      }
      let duplicates = 0, duplicateSpecies = 0;
      for (const n of perSpecies.values()) if (n > 1) { duplicates += n - 1; duplicateSpecies++; }

      let released = 0, shinyCaught = 0, caughtTotal = 0;
      for (const r of dex.all()) { released += r.released; shinyCaught += r.shinyCaught; caughtTotal += r.caught; }

      return {
        // The flat figures other modules read. `economy` gates its shelves on `caught`.
        seen: c.seen,
        caught: c.caught,
        owned: c.owned,
        stored: stored.length,
        released,
        overflow,
        total: c.total,
        dexPct: c.caughtPct,
        seenPct: c.seenPct,
        livingDexPct: c.livingPct,
        caughtTotal,
        shiny: shinyCaught,
        shinyOwned,
        shinySpecies: dex.all().filter((r) => r.shinyCaught > 0).length,
        duplicates,
        duplicateSpecies,
        favourites,
        uniqueOwned: perSpecies.size,
        averageIvPct: stored.length ? +((ivSum / stored.length / IV_TOTAL_MAX) * 100).toFixed(1) : 0,
        averageLevel: stored.length ? +(levelSum / stored.length).toFixed(1) : 0,
        highestLevel: highest,
        boxes: bs,
        forms: c.forms,
        byGen: c.byGen,
        byType: c.byType,
      };
    }

    const api = {
      // --- ARCHITECTURE §5.10 -----------------------------------------------

      /**
       * The dex. `seen` and `caught` are species-name arrays (the shape the save layer and
       * the seed API expect); `records` and `completion` are the interesting parts.
       */
      dex() {
        return {
          seen: dex.seenKeys(),
          caught: dex.caughtKeys(),
          total: dex.universe.species,
          records: dex.all(),
          completion: dex.completion(),
          universe: { ...dex.universe, gens: dex.universe.gens.slice(), types: dex.universe.types.slice() },
        };
      },

      boxes: publicBoxes,

      /** Moves a Pokémon to an exact slot, swapping with whatever is already there. */
      move(ref, box, slot) {
        const entry = resolve(ref);
        if (!entry) return false;
        return boxes.move(entry.uid, Number(box), Number(slot));
      },

      /**
       * Re-lays storage in one of nine total orderings. `{ box: n }` sorts one box in place;
       * without it the whole storage is gathered, sorted and re-laid from box 0 slot 0 —
       * the mainline's "sort all boxes", which also compacts away every gap.
       */
      sort(mode = 'species', { desc = false, box = null } = {}) {
        if (!SORT_MODES[mode]) { log.warn(`collection.sort: unknown mode "${mode}"`); return false; }
        if (box == null) {
          boxes.layout(sortEntries(boxes.all(), mode, { desc }));
          return true;
        }
        const b = boxes.box(Number(box));
        if (!b) return false;
        boxes.layoutBox(b.index, sortEntries(b.slots.filter(Boolean), mode, { desc }));
        return true;
      },

      /** Releases one. Credits `economy` unless told not to. */
      release(ref, opts) {
        const result = releaseOne(ref, opts);
        if (!result) return false;
        if (!quiet) {
          bus.emit('ui:toast', {
            text: `${result.entry.display} was released — ₽${Math.round(result.value.money).toLocaleString('en-US')}`,
            kind: 'info',
          });
        }
        return true;
      },

      stats: summary,

      // --- storage ----------------------------------------------------------
      capacity: () => boxes.capacity,
      boxCount: () => boxes.count(),
      totalSlots: () => boxes.totalSlots(),
      count: () => boxes.used(),
      free: () => boxes.free(),
      isFull: () => boxes.isFull(),
      entries: () => boxes.all(),
      entry: resolve,
      at: (b, s) => boxes.at(Number(b), Number(s)),
      box: (i) => publicBoxes()[i] ?? null,
      swap: (b1, s1, b2, s2) => boxes.swap(Number(b1), Number(s1), Number(b2), Number(s2)),
      rename: (i, name) => boxes.rename(Number(i), name),
      setWallpaper: (i, w) => boxes.setWallpaper(Number(i), w),
      addBox: () => boxes.addBox(),
      wallpapers: () => WALLPAPERS.slice(),
      layout: () => ({ capacity: boxes.capacity, cols: BOX_COLS, rows: BOX_ROWS }),

      /**
       * Puts a Pokémon in storage directly — a gift, a trade, a Wonder Trade voucher, or a
       * restored save. Goes through exactly the same path a wild catch does.
       */
      deposit(spec) {
        const r = intake({ origin: 'gift', ...spec });
        return r.stored ? r.entry : null;
      },

      // --- dex --------------------------------------------------------------
      /**
       * Records a sighting without a catch — the other half of `encounter:started`, for a
       * caller that met a Pokémon outside the event path (a bulk import, a trade offer, a
       * Pokémon that fled). Dex only; nothing enters storage.
       */
      sight(species, { shiny = false } = {}) {
        const key = String(species?.name ?? species ?? '').toLowerCase();
        if (!key) return null;
        return dex.see(key, { shiny, ordinal: ordinal++, simTime: now() });
      },
      record: (key) => dex.get(key),
      records: () => dex.all(),
      seen: (key) => (dex.get(key)?.seen ?? 0) > 0,
      caught: (key) => (dex.get(key)?.caught ?? 0) > 0,
      owned: (key) => (dex.get(key)?.owned ?? 0),
      completion: () => dex.completion(),
      /** `{ owned, ever }` — the best you still have, and the best you ever rolled. */
      bestIv(key) {
        const r = dex.get(key);
        return r ? { owned: r.bestOwned, ever: r.bestEver } : null;
      },
      /** The best-IV line for every species held, best first. */
      bestIvs(limit = 20) {
        return dex.all().filter((r) => r.bestOwned)
          .map((r) => ({ species: r.key, display: r.display, dexId: r.id, ...r.bestOwned }))
          .sort((a, b) => b.total - a.total || (a.dexId ?? 1e9) - (b.dexId ?? 1e9))
          .slice(0, limit);
      },

      // --- duplicates -------------------------------------------------------
      /** Every species held more than once, biggest pile first. */
      duplicates(min = 2) {
        return groupBySpecies(boxes.all()).filter((g) => g.count >= min);
      },
      duplicatesOf: (species) => ownedOf(String(species).toLowerCase()),

      /** What a release rule *would* do. Pure: nothing moves. */
      planRelease(rule = {}) {
        const protectedUids = new Set([...partyUids(), ...(rule.protectedUids ?? [])]);
        const plan = planDuplicateRelease(boxes.all(), { ...rule, protectedUids });
        const economy = ctx.get('economy');
        const appraise = isLive(economy) && typeof economy.appraise === 'function' ? economy.appraise : null;
        let money = 0, shards = 0;
        if (appraise) {
          for (const e of plan.release) {
            const v = appraise({ level: e.level, shiny: e.shiny, species: speciesOf(e.species) ?? { baseStats: {} } }) ?? {};
            money += v.money ?? 0;
            shards += v.shards ?? 0;
          }
        }
        return { ...plan, value: { money, shards }, count: plan.release.length };
      },

      /** Applies a release rule. `dryRun` returns the plan without touching storage. */
      releaseDuplicates(rule = {}) {
        const plan = api.planRelease(rule);
        if (rule.dryRun) return plan;
        let money = 0, shards = 0;
        const wasQuiet = quiet;
        quiet = true;
        for (const e of plan.release) {
          const r = releaseOne(e.uid, { credit: rule.credit !== false });
          if (r) { money += r.value.money; shards += r.value.shards; }
        }
        quiet = wasQuiet;
        dex.recount(boxes.all());
        if (plan.release.length && !quiet) {
          bus.emit('ui:toast', {
            text: `Released ${plan.release.length} duplicates — ₽${Math.round(money).toLocaleString('en-US')}`,
            kind: 'info',
          });
        }
        return { ...plan, value: { money, shards }, applied: true };
      },

      releaseMany(refs = [], opts = {}) {
        const wasQuiet = quiet;
        quiet = true;
        let n = 0, money = 0, shards = 0;
        for (const ref of refs) {
          const r = releaseOne(ref, opts);
          if (r) { n++; money += r.value.money; shards += r.value.shards; }
        }
        quiet = wasQuiet;
        dex.recount(boxes.all());
        return { released: n, value: { money, shards } };
      },

      keepRules: () => Object.values(KEEP_RULES).map((r) => ({ id: r.id, label: r.label })),

      // --- flags ------------------------------------------------------------
      favourite(ref, on = true) {
        const e = resolve(ref);
        if (!e) return false;
        e.favourite = !!on;
        return true;
      },
      nickname(ref, name) {
        const e = resolve(ref);
        if (!e) return false;
        e.nickname = name ? String(name).slice(0, 12) : null;
        return true;
      },

      // --- sorting ----------------------------------------------------------
      sortModes: () => SORT_IDS.map((id) => ({ id, label: SORT_MODES[id].label, blurb: SORT_MODES[id].blurb })),
      /** Sorts a list without touching storage — for a UI preview. */
      sorted: (mode = 'species', opts) => sortEntries(boxes.all(), mode, opts),

      // --- helpers others may want -----------------------------------------
      ivTotal, ivPct, ivGrade,
      IV_TOTAL_MAX,

      // --- persistence (the seam src/offline/slices.js prefers) --------------
      saveState() {
        return {
          v: SAVE_VERSION,
          ordinal,
          overflow,
          dex: dex.serialize(),
          boxes: boxes.meta(),
          stored: boxes.all().map((e) => [
            e.uid, e.instanceId, e.species, e.level, e.shiny ? 1 : 0,
            IV_KEYS.map((k) => e.ivs[k]), e.ordinal, +e.simTime.toFixed(2),
            e.box, e.slot, e.biome, e.ball, e.origin, e.nickname, e.favourite ? 1 : 0,
          ]),
        };
      },

      /**
       * Restores a save. Deliberately **silent**: replaying a collection through the normal
       * intake path would re-fire `collection:added` and toast the player once per Pokémon
       * they already own (the reason `src/offline/slices.js` never restored this module).
       * Slots are honoured exactly, so a sorted box comes back sorted.
       */
      loadState(value) {
        if (!value || typeof value !== 'object') return false;
        if (Number(value.v) > SAVE_VERSION) {
          log.warn(`collection: save slice v${value.v} is newer than v${SAVE_VERSION} — ignored`);
          return false;
        }
        const wasQuiet = quiet;
        quiet = true;
        try {
          boxes.clearAll();
          boxes.setMeta(value.boxes ?? []);
          dex.deserialize(value.dex ?? {});
          ordinal = Number(value.ordinal) || 0;
          overflow = Number(value.overflow) || 0;

          for (const row of value.stored ?? []) {
            if (!Array.isArray(row)) continue;
            const [uid, instanceId, species, level, shiny, ivArr, ord, simTime, box, slot, biome, ball, origin, nickname, favourite] = row;
            const ivs = {};
            IV_KEYS.forEach((k, i) => { ivs[k] = ivArr?.[i] ?? 0; });
            const entry = makeEntry({
              uid, instanceId, species, level, shiny: !!shiny, ivs, ordinal: ord,
              simTime, biome, ball, origin: origin ?? 'restore', nickname, favourite: !!favourite,
            });
            if (!boxes.place(entry, box, slot)) boxes.deposit(entry);
            if (entry.ordinal >= ordinal) ordinal = entry.ordinal + 1;
          }
          // Owned counts and best-owned are derived, never trusted from the file: rebuilding
          // them from the storage that was just restored makes the two impossible to desync.
          dex.recount(boxes.all());
          return true;
        } catch (err) {
          log.warn('collection: save slice could not be restored', err);
          return false;
        } finally {
          quiet = wasQuiet;
        }
      },

      // --- diagnostics ------------------------------------------------------
      /** Bulk import used by the showcase and by the self-test. Silent by construction. */
      importBatch(specs = [], { announce = false } = {}) {
        const wasQuiet = quiet;
        quiet = true;
        const added = [];
        for (const s of specs) added.push(intake(s, { announce }));
        quiet = wasQuiet;
        return added;
      },
      setQuiet(on) { quiet = !!on; },
      overflowCount: () => overflow,
      ordinal: () => ordinal,
      async selfTest() {
        const { runSelfTest } = await import('./selftest.js');
        const result = await runSelfTest(api, ctx);
        reportSelfTest('collection', result);
        return result;
      },
    };

    /** Party members are never released by a rule; they are not in the boxes to begin with. */
    function partyUids() {
      const p = ctx.get('pokemon');
      if (!isLive(p) || typeof p.party !== 'function') return new Set();
      const out = new Set();
      for (const m of p.party() ?? []) if (m?.instanceId) out.add(m.instanceId);
      return out;
    }

    live = { off };
    return api;
  },

  dispose() {
    for (const fn of live?.off ?? []) { try { fn(); } catch { /* already gone */ } }
    live = null;
  },

  async showcase(mode, ctx) {
    const { showcaseCollection } = await import('./showcase.js');
    return showcaseCollection(mode, ctx);
  },
};
