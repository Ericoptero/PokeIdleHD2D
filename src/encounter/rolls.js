/**
 * rolls.js — every random decision an encounter makes, as pure functions of
 * `(seed, index)`.
 *
 * This file has no `ctx`, no clock, no module lookups and no `Math.random`. It is the
 * reason the same seed and the same encounter index give the same species, level, shiny
 * and IVs whether the encounter was rolled live in the browser or replayed from a log in
 * Node — `selftest.js` runs the whole of it with no browser at all.
 *
 * ## Why index-addressed and not stream-continued
 *
 * `idle` resolves encounters **by index** while the tab is closed (DECISIONS #19): encounter
 * N is always rolled from its own stream, so a chunk boundary cannot renumber, add or drop
 * one. A live encounter has the same problem in a different shape — the player may reload,
 * a save may be restored mid-hunt, and `offline` may apply a gap between two steps in the
 * same patch of grass. So nothing here reads a stream that was left running: every roll
 * derives its own stream from the index it is rolling, and the module's only persistent
 * state is two integers (`steps` and `encounters`).
 *
 * ## The label convention, and why it is spelled out here
 *
 * `ctx.rng` is `makeRng(config.seed, 'root')` and `fork(label)` appends `/label`
 * (`core/rng.js`). So `ctx.rng.fork('encounter').fork('roll/7')` is exactly
 * `makeRng(seed, 'root/encounter/roll/7')`, which is what `streamFor(seed, 'roll', 7)`
 * builds. Spelling the label out lets this file run in Node with no `ctx` while staying
 * bit-identical to the browser's fork chain — and `selftest.js` asserts that identity
 * rather than trusting this comment.
 *
 * Sibling streams never interfere, so an encounter roll cannot perturb `collection`'s IV
 * stream, `simulation`'s wander or `idle`'s accrual (ARCHITECTURE §2.5).
 */

import { makeRng } from '../core/rng.js';

/** The prefix `ctx.rng.fork('encounter')` produces. Never change without a save migration. */
export const STREAM_ROOT = 'root/encounter';

/** Base shiny odds — the Gen 6+ number, and the same one `idle/accrual.js` uses. */
export const SHINY_RATE = 1 / 4096;
/** With the charm, again matching `idle`. */
export const SHINY_RATE_CHARM = 1 / 1365;

/** Six IV keys in the order `collection/dex.js` and `pokemon.createInstance` use. */
export const IV_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/**
 * One roll's own stream.
 *
 * @param {number} seed   `config.seed`
 * @param {string} kind   'step' | 'roll' | 'catch' | 'battle'
 * @param {string|number} key  the index (and, for a catch, `index/turn`)
 */
export function streamFor(seed, kind, key) {
  return makeRng(seed, `${STREAM_ROOT}/${kind}/${key}`);
}

/**
 * A capture rate for species the snapshot does not carry one for.
 *
 * `public/generated/species.json` was built from the overworld sprite sheets and has no
 * capture-rate column, but `economy.catchOdds` needs one and a flat 45 would make a
 * Caterpie and a Dragonite identical to every ball in the bag.
 *
 * **This is character-for-character the same curve as `automation/fields.js`**, which
 * declared the proxy first. Modules may not import each other's internals (§5), so the two
 * copies are a mirror in the same sense `economy/pacing.js` mirrors `idle/accrual.js`; a
 * seam test asserting they agree would be worth writing. Meanwhile `tables.js` carries
 * the **real mainline rate** for every species it can actually spawn, so this curve is only
 * reached for a species some other module asks about.
 *
 * Monotone decreasing in BST and landing on the familiar landmarks: BST ~195 → ~255,
 * ~450 → ~60, 600 → ~10, 680+ → the floor of 3.
 */
export function catchRateFor(bst) {
  const b = Number.isFinite(bst) && bst > 0 ? bst : 300;
  const t = clamp((b - 190) / (720 - 190), 0, 1);
  return clamp(Math.round(255 * Math.pow(1 - t, 2.2)), 3, 255);
}

/**
 * The wild level band, scaled to the party's best member.
 *
 * Copied from `idle/accrual.js`'s `wildLevelBand` on purpose: a route that spawns level-4
 * wildlife while the tab is open and level-40 wildlife while it is closed would make the
 * idle layer feel like a different game. Same reason `economy/pacing.js` mirrors idle's
 * income constants.
 */
export function levelBand(topLevel) {
  const top = Math.max(1, Number(topLevel) || 5);
  return { min: Math.max(2, Math.round(top * 0.6)), max: Math.max(3, Math.round(top * 1.15) + 1) };
}

/**
 * Does step number `stepIndex` through tall grass start an encounter?
 *
 * Indexed by *how many grass cells have been walked*, not by time, so a step is worth the
 * same whether the player crossed the patch in one go or reloaded halfway. `rate` is the
 * per-step probability (`config`-free: the caller composes it from the biome and whatever
 * `economy` upgrades are live).
 */
export function stepRoll(seed, stepIndex, rate) {
  return stepValue(seed, stepIndex) < clamp(rate, 0, 1);
}

/** The raw coin behind `stepRoll`, so a showcase can print the roll beside its verdict. */
export function stepValue(seed, stepIndex) {
  return streamFor(seed, 'step', stepIndex).next();
}

/**
 * Encounter number `index`: what is in the grass.
 *
 * **The draw order is part of the contract.** Species, then level, then shiny, then six
 * IVs, always, whether or not the caller ends up looking at all of them — reordering or
 * skipping a draw here changes every encounter ever rolled from every seed. Adding a new
 * roll goes on the END, and `selftest.js` pins the first few values of a known seed so a
 * reorder cannot land quietly.
 *
 * @param {number} seed
 * @param {number} index  cumulative encounter number, from 0
 * @param {{table:string[], band:{min:number,max:number}, shinyRate?:number, bumps?:Object}} opts
 *   `table` is the weight-expanded species list (`tables.js` `expand()`), so a uniform pick
 *   from it *is* the weighted pick.
 * @returns {{index:number, species:string, level:number, shiny:boolean, ivs:Object, ivTotal:number}|null}
 */
export function rollAt(seed, index, { table, band, shinyRate = SHINY_RATE, bumps = null } = {}) {
  if (!Array.isArray(table) || table.length === 0) return null;
  const rng = streamFor(seed, 'roll', index);

  const species = table[Math.floor(rng.next() * table.length)];

  const span = Math.max(0, band.max - band.min);
  const bump = bumps && Number.isFinite(bumps[species]) ? bumps[species] : 0;
  const level = clamp(band.min + Math.floor(rng.next() * (span + 1)) + bump, 1, 100);

  const shiny = rng.next() < clamp(shinyRate, 0, 1);

  const ivs = {};
  let ivTotal = 0;
  for (const k of IV_KEYS) { const v = rng.int(0, 31); ivs[k] = v; ivTotal += v; }

  return { index, species, level, shiny, ivs, ivTotal };
}

/**
 * RETIRED (DECISIONS #67). A battle was eleven lines comparing two levels and rolling a coin;
 * it is `src/battle/`'s turn engine now — four moves with PP, the type chart, criticals,
 * statuses and stat stages — on its own `root/battle/<index>/<turn>` streams.
 *
 * The function is **deleted rather than left exported**: a pure function nothing calls is a
 * second model of combat sitting next to the real one, and the next person to need a battle
 * outcome would find two. What it measured is pinned in `src/battle/selftest.js`, and the
 * `battle/12` clause it anchored is deleted from this module's stream pin with a note saying
 * why. The other three pins did not move, which is the evidence the index space survived.
 */


/**
 * The ball roll for attempt `turn` (1-based) at encounter `index`.
 *
 * Its own stream per turn, so throwing a second ball can never be predicted from the first
 * and a reload between two throws cannot replay the same number. `economy` computes the
 * odds and never rolls them (see `economy/items.js`); this is where the coin lands.
 */
export function catchRoll(seed, index, turn) {
  return streamFor(seed, 'catch', `${index}/${turn}`).next();
}

/**
 * How many wobbles the ball shows before it settles, from the same odds.
 *
 * Cosmetic, but not arbitrary: Gen 3/4 shakes the ball four times and the mainline shows
 * how close you came, so a near-miss on a 40 % throw should wobble three times and a
 * hopeless one should pop straight open. Derived from the roll that already happened, so it
 * costs no extra draw and can never disagree with the result.
 */
export function shakesFor(roll, odds, caught) {
  if (caught) return 3;
  const p = clamp(odds, 1e-6, 1);
  // p(shake) = p(catch)^(1/4) — invert the Gen 3/4 formula to ask how many of the four
  // independent shake checks this roll would have passed.
  const perShake = Math.pow(p, 0.25);
  let n = 0;
  while (n < 3 && Math.pow(perShake, n + 1) > roll) n++;
  return n;
}

/**
 * What an encounter pays.
 *
 * Mirrors `idle/accrual.js`'s reward scale (`scale = 1 + level*0.16`, 8 money and 6 exp per
 * unit of scale on a win, a sixfold money bonus on a shiny) so a battle fought at the
 * keyboard is worth the same as one the idle layer resolved while the tab was closed. A
 * catch pays a bonus on top, because spending a ball has to be worth more than walking away.
 *
 * Pure: `economy` applies its own income multipliers at the `add()` boundary (DECISIONS #16),
 * so these are the pre-multiplier numbers and this file never asks the wallet anything.
 */
export function rewardsFor(level, { win = false, caught = false, shiny = false } = {}) {
  const scale = 1 + Math.max(1, Number(level) || 1) * 0.16;
  let money = win ? Math.round(8 * scale) : 0;
  let exp = Math.round((win ? 6 : 1.5) * scale);
  if (caught) { money = Math.round(money * 1.5); exp = Math.round(exp * 1.25); }
  if (shiny) money *= 6;
  return { money, exp };
}
