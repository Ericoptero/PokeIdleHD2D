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

export const CURRENT_VERSION = 3;

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
];

/** Human-readable chain, for the debug overlay and the showcase panel. */
export const MIGRATION_CHAIN = MIGRATIONS.map((m) => `v${m.to - 1}→v${m.to}: ${m.describe}`);
