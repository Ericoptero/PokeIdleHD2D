/**
 * What actually goes in the save, and how it gets back out.
 *
 * Ownership makes this awkward on purpose: `offline` owns the save *format*, but every
 * other module owns its own *state*, and `offline` may not reach into another folder. Two
 * mechanisms bridge that, in this order of preference:
 *
 *   1. **native** — a module exposes `saveState()` / `loadState(value)` on its public API.
 *      That is the seam we want everyone on; it needs no knowledge here at all.
 *   2. **adapter** — until a module has those, a small adapter in this file expresses its
 *      state through its *published* API only (`ctx.get(id)`, never a deep import). Every
 *      call is feature-detected, so an adapter degrades to nothing the moment a builder
 *      reshapes their module, and it disappears entirely the moment they add `saveState`.
 *
 * An adapter that can capture but not restore (`restore: null`) still earns its place: the
 * bytes are preserved across sessions, so no player data is lost in the window before the
 * owning module grows a way to load it back.
 */

/**
 * The registry's null object answers every property with a function, so `typeof
 * api.saveState === 'function'` is true even for a module that failed. `__missing` is the
 * one property it answers honestly.
 */
const isLive = (api) => !!api && api.__missing === undefined;
const fn = (api, name) => (isLive(api) && typeof api[name] === 'function' ? api[name].bind(api) : null);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Currencies the economy adapter knows to ask about; unknown ones are simply not saved. */
const CURRENCIES = ['money', 'tokens'];

/**
 * Adapters, keyed by module id. `capture(api, ctx)` returns JSON-safe state or undefined;
 * `restore(value, api, ctx)` puts it back, or is null when the module has no way to accept
 * it yet — recorded rather than pretended away.
 */
export const ADAPTERS = {
  economy: {
    order: 10,
    capture(api) {
      const balance = fn(api, 'balance');
      const inventory = fn(api, 'inventory');
      if (!balance && !inventory) return undefined;
      const wallet = {};
      if (balance) for (const c of CURRENCIES) {
        const v = balance(c);
        if (typeof v === 'number' && Number.isFinite(v)) wallet[c] = v;
      }
      const items = inventory?.() ?? null;
      const out = { wallet };
      if (items && typeof items === 'object') out.items = { ...items };
      return out;
    },
    restore(value, api) {
      const add = fn(api, 'add');
      const balance = fn(api, 'balance');
      if (add && balance) {
        for (const [c, want] of Object.entries(value?.wallet ?? {})) {
          const delta = num(want) - num(balance(c));
          if (delta !== 0) add(c, delta, 'save:restore');
        }
      }
      const count = fn(api, 'count');
      const give = fn(api, 'give');
      const take = fn(api, 'take');
      if (count && give && take) {
        for (const [id, want] of Object.entries(value?.items ?? {})) {
          const delta = num(want) - num(count(id));
          if (delta > 0) give(id, delta);
          else if (delta < 0) take(id, -delta);
        }
      }
    },
  },

  // NOTE (DECISIONS #61): `pokemon` now ships `saveState`/`loadState`, so the native seam
  // wins and this adapter is dead code on every normal boot. It is kept, not deleted, for the
  // one case it still covers: a quarantined `pokemon` whose API is the registry's null object,
  // where `fn(api,'party')` returns undefined and this contributes nothing rather than
  // throwing. The native slice carries moves, PP and a real maxHp; this one never could.
  pokemon: {
    order: 5,
    capture(api) {
      const party = fn(api, 'party');
      if (!party) return undefined;
      const list = party() ?? [];
      return {
        party: list.map((p) => ({
          instanceId: p?.instanceId ?? null,
          species: p?.species?.name ?? p?.species ?? null,
          level: num(p?.level, 1),
          shiny: !!p?.shiny,
          exp: num(p?.exp, 0),
          hp: num(p?.hp, 1),
        })).filter((p) => p.species),
      };
    },
    restore(value, api) {
      const create = fn(api, 'createInstance');
      const addToParty = fn(api, 'addToParty');
      const party = fn(api, 'party');
      if (!create || !addToParty || !party) return;
      if ((party() ?? []).length) return;              // a live party wins over a saved one
      for (const [i, p] of (value?.party ?? []).entries()) {
        const inst = create({ species: p.species, level: p.level, shiny: p.shiny, seed: i });
        if (!inst) continue;
        if (p.instanceId) inst.instanceId = p.instanceId;
        inst.exp = p.exp; inst.hp = p.hp;
        addToParty(inst);
      }
    },
  },

  idle: {
    order: 15,
    // `idle` carries cumulative encounter progress (accrual.js indexes encounter N off its
    // own stream, so the same seed must not restart at index 0 every session or every run
    // would meet the same first Pokemon). Captured here when `idle` publishes it; `offline`
    // keeps its own authoritative copy in the meantime — see index.js.
    capture(api) {
      const progress = fn(api, 'progress');
      const unlocks = fn(api, 'unlocks');
      const upgrades = fn(api, 'upgrades');
      if (!progress && !unlocks && !upgrades) return undefined;
      const out = {};
      if (progress) out.progress = progress();
      if (unlocks) out.unlocks = unlocks();
      if (upgrades) out.upgrades = upgrades();
      return out;
    },
    restore(value, api) {
      const setProgress = fn(api, 'setProgress');
      if (setProgress && value?.progress) setProgress(value.progress);
      const setUnlocks = fn(api, 'setUnlocks');
      if (setUnlocks && value?.unlocks) setUnlocks(value.unlocks);
      const setUpgrades = fn(api, 'setUpgrades');
      if (setUpgrades && value?.upgrades) setUpgrades(value.upgrades);
    },
  },

  automation: {
    order: 30,
    capture(api) { const rules = fn(api, 'rules'); return rules ? { rules: rules() } : undefined; },
    restore(value, api) { const set = fn(api, 'set'); if (set && value?.rules) set(value.rules); },
  },

  simulation: {
    order: 40,
    capture(api, ctx) {
      const player = fn(api, 'player');
      if (!player) return undefined;
      const p = player() ?? {};
      // `handle()` returns `{ id, … }` (terrain/index.js), so this is the map's real id and
      // `restorePlayer`'s `want.mapId !== mapId` guard does match — the comment that used to sit
      // here, claiming the read was always `null`, was describing a bug that had been fixed.
      // Measured harmless in a hunt: the scene places the party first and the restore lands on a
      // loop cell (slice 012, probe B).
      const mapId = ctx.get('terrain')?.handle?.()?.id ?? null;
      if (!Number.isFinite(p.cx) || !Number.isFinite(p.cz)) return undefined;
      return { mapId, cx: p.cx, cz: p.cz, dir: num(p.dir, 0) };
    },
    // Restored on world:loaded rather than at hydrate time: at hydrate there is no map yet,
    // and the scene module places the player when it enters. See index.js.
    restore: null,
    unrestoredWhy: 'deferred to the first world:loaded event, once a map exists to stand on',
  },
};

/**
 * Builds the provider list for a context: native seams where they exist, adapters where
 * they do not, nothing at all for modules that are absent or quarantined.
 *
 * @returns {{id:string, source:'native'|'adapter', order:number, seam?:string,
 *            capture:Function, restore:Function|null, unrestoredWhy?:string}[]}
 */
export function discoverProviders(ctx, ids = Object.keys(ADAPTERS)) {
  const out = [];
  const seen = new Set();
  for (const id of [...ids, ...Object.keys(ADAPTERS)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const api = ctx.get(id);
    if (!isLive(api)) continue;

    // Two spellings of the same seam are accepted: `saveState`/`loadState`, and the
    // `snapshot`/`restore` pair `idle` shipped. Both halves must be present before either
    // is believed — a lone `snapshot()` on some future module is far more likely to mean
    // something else entirely than to mean "here is my save state".
    const native = [['saveState', 'loadState'], ['snapshot', 'restore']]
      .map(([s, l]) => ({ save: fn(api, s), load: fn(api, l), names: `${s}/${l}` }))
      .find((pair) => pair.save && pair.load);
    if (native) {
      out.push({
        id, source: 'native', order: ADAPTERS[id]?.order ?? 50,
        capture: () => native.save(), restore: (v) => native.load(v), seam: native.names,
      });
      continue;
    }
    const halfNative = fn(api, 'saveState');
    if (halfNative) {
      out.push({ id, source: 'native', order: ADAPTERS[id]?.order ?? 50, capture: () => halfNative(), restore: null,
        unrestoredWhy: `${id}.saveState() exists but ${id}.loadState() does not` });
      continue;
    }
    const adapter = ADAPTERS[id];
    if (!adapter) continue;
    // The probe is a real call into a module someone else is still writing. If it throws,
    // that module simply does not get a slice; it must not take the save system down.
    let probe;
    try { probe = adapter.capture(api, ctx); } catch { continue; }
    if (probe === undefined) continue;              // the module cannot express this state
    out.push({
      id, source: 'adapter', order: adapter.order,
      capture: () => adapter.capture(api, ctx),
      restore: adapter.restore ? (v) => adapter.restore(v, api, ctx) : null,
      unrestoredWhy: adapter.restore ? undefined : adapter.unrestoredWhy,
    });
  }
  return out.sort((a, b) => a.order - b.order);
}
