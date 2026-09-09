/**
 * Save versions and the forward migrations between them (ARCHITECTURE §10).
 *
 * Rules that hold forever:
 *   - a migration is `v(n) -> v(n+1)`; they run in order and none is ever skipped,
 *   - a migration is pure and total: given any object that a previous build could have
 *     written, it returns an object the next version understands, and it never throws for
 *     a missing field — it substitutes,
 *   - old versions are never deleted from this file. The v1 reader is what lets a save
 *     from the first day of the project still open.
 *
 * Adding a version means: bump CURRENT_VERSION, append one MIGRATIONS entry, extend
 * `freshSave` if the new version adds fields, and add a case to `selftest.js`.
 */

export const CURRENT_VERSION = 4;

/** A brand-new document. Every field the current version expects, none of them optional. */
export function freshSave(nowMs, seed = 0, version = CURRENT_VERSION) {
  return {
    v: version,
    createdMs: nowMs,
    lastSeenMs: nowMs,
    savedAtMs: nowMs,
    meta: { sessions: 0, playSeconds: 0, seed, build: 1 },
    slices: {},
  };
}

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const obj = (v) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {});

export const MIGRATIONS = [
  {
    to: 2,
    describe: 'v1 kept a flat `totals` bag; v2 introduces per-module `slices` and `createdMs`',
    apply(s) {
      const totals = obj(s.totals);
      const lastSeenMs = num(s.lastSeenMs, num(s.savedAtMs, 0));
      const out = {
        v: 2,
        createdMs: num(s.createdMs, lastSeenMs),
        lastSeenMs,
        slices: obj(s.slices),
      };
      // The one thing v1 actually stored: the money total.
      if (Object.keys(totals).length) {
        out.slices.economy = {
          ...obj(out.slices.economy),
          wallet: { ...obj(obj(out.slices.economy).wallet), money: num(totals.money, 0) },
        };
      }
      return out;
    },
  },
  {
    to: 3,
    describe: 'v3 adds `meta` (sessions, playSeconds, seed, build) and a separate `savedAtMs`',
    apply(s) {
      const lastSeenMs = num(s.lastSeenMs, 0);
      return {
        v: 3,
        createdMs: num(s.createdMs, lastSeenMs),
        lastSeenMs,
        savedAtMs: num(s.savedAtMs, lastSeenMs),
        meta: {
          sessions: num(obj(s.meta).sessions, 0),
          // v2 saves carry no play time; starting the counter at 0 under-reports rather
          // than inventing a number, which is the honest direction to be wrong in.
          playSeconds: num(obj(s.meta).playSeconds, num(s.playSeconds, 0)),
          seed: num(obj(s.meta).seed, num(s.seed, 0)),
          build: num(obj(s.meta).build, 1),
        },
        // Unknown slices are carried through untouched: a save written by a build that
        // knew about a module this one does not must survive the round trip.
        slices: obj(s.slices),
      };
    },
  },
  {
    to: 4,
    describe: 'v4: `pokemon` grows a native slice (stats, HP, moves, PP) and the old adapter shape is dropped',
    apply(s) {
      const slices = obj(s.slices);
      const old = obj(slices.pokemon);
      // The v3 adapter stored `{ party: [{ instanceId, species, level, shiny, exp, hp }] }`
      // and rebuilt the party through `createInstance`, so it never carried moves, PP or a
      // real maxHp. Everything it DID carry is still meaningful, so it is forwarded rather
      // than dropped: `instance.deserialize` rebuilds stats and the move list from the
      // species and the level anyway, which is §5's "derived state is rebuilt, never trusted".
      //
      // The one field that cannot survive is `hp`. v3 wrote a literal 1 for every Pokemon
      // (`createInstance` hardcoded it), so carrying it forward would restore a full party at
      // one hit point. It is dropped and `deserialize` fills in full health.
      const party = Array.isArray(old.party) ? old.party : [];
      return {
        ...s,
        v: 4,
        slices: {
          ...slices,
          pokemon: party.length
            ? {
              v: 1,
              ordinal: party.length,
              party: party.map((p, i) => ({
                instanceId: typeof p?.instanceId === 'string' && p.instanceId.includes('#')
                  ? p.instanceId : `${p?.species ?? 'unknown'}#${i}`,
                species: p?.species ?? null,
                level: num(p?.level, 5),
                shiny: !!p?.shiny,
                exp: num(p?.exp, 0),
                ivs: obj(p?.ivs),
                moves: [],
                priority: [],
                status: null,
              })).filter((p) => p.species),
            }
            : slices.pokemon,
        },
      };
    },
  },
];

/** Human-readable chain, for the debug overlay and the showcase panel. */
export const MIGRATION_CHAIN = MIGRATIONS.map((m) => `v${m.to - 1}→v${m.to}: ${m.describe}`);
