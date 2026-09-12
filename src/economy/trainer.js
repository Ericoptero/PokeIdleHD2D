/**
 * The trainer's own level.
 *
 * The trainer has a level, and it gates which maps `travel` will take the
 * party to. This is that number, and it is **derived from a counter this module already
 * keeps** rather than stored: `progress().battlesWon` has been incremented on every
 * `encounter:resolved` since `economy` was written, so there is no new state, no new save
 * slice and no migration — and a trainer level that disagreed with the battle count would be
 * a bug that could only be found by playing.
 *
 * Why battles won and not experience: experience belongs to the *Pokémon*, and a trainer who
 * levelled from it would level fastest by sending in the strongest thing they had. Wins are
 * the thing the player did.
 *
 * Pure: no ctx, no clock, no RNG. It runs in Node.
 */

/**
 * Wins needed to *reach* level `n`, triangular.
 *
 *     wins(n) = STEP · n · (n − 1) / 2
 *
 * Triangular rather than exponential because a gate is a schedule, not a wall: each level
 * costs `STEP` more wins than the last, so the curve is legible from the inside — "three more
 * than last time" — and the biome gates land where they were authored. With `STEP` at 3:
 *
 *     level  2    5    12    20    30
 *     wins   3   30   198   570  1305
 *
 * The hunt gates (src/hunts/index.js) are meadow 0, forest 5, coast 12, cave 20 — so the forest opens after
 * thirty wins, the coast after two hundred, and the cave is a long way in.
 */
export const STEP = 3;

export const winsForLevel = (n) => (STEP * Math.max(0, n) * Math.max(0, n - 1)) / 2;

/** The level a win count buys. Monotone, starts at 1, and has no ceiling. */
export function levelFromWins(wins) {
  const w = Math.max(0, Math.floor(Number(wins) || 0));
  // Closed form of the triangular inverse, floored — a loop would be fine and this is called
  // on every HUD redraw.
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * w) / STEP)) / 2));
}

/**
 * Everything a HUD or a gate needs.
 * @param {number} wins
 * @returns {{level:number, wins:number, into:number, need:number, next:number}}
 */
export function trainerFromWins(wins) {
  const w = Math.max(0, Math.floor(Number(wins) || 0));
  const level = levelFromWins(w);
  const at = winsForLevel(level);
  const next = winsForLevel(level + 1);
  return { level, wins: w, into: w - at, need: next - at, next };
}
