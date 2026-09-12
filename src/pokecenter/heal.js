// @ts-check
/**
 * The cure's cooldown arithmetic — pure, no `ctx`, testable under plain vitest/Node the way
 * `battle/engine.js` is (pin against literals, never a second live call).
 *
 * `src/pokecenter/index.js` is the one caller: it stamps `lastHealMs` to `ctx.clock.wallMs()`
 * every time Nurse Joy actually cures the party, and asks `remainingCooldownMs` before every
 * attempt.
 */

/** How long the cure needs to recharge, in real (wall-clock) milliseconds. */
export const HEAL_COOLDOWN_MS = 60_000;

/**
 * How much cooldown remains at `nowMs`, given the cure last fired at `lastHealMs`.
 *
 * `lastHealMs` not a finite number reads as "never healed" — zero cooldown, not an infinite
 * one — so a fresh save and a wiped party (which never arms the cooldown, `index.js`'s own
 * `player:enteredTile`/`party:wiped` paths never call this) can always be cured immediately.
 *
 * @param {number|null|undefined} lastHealMs
 * @param {number} nowMs
 * @returns {number} milliseconds remaining; `0` means the cure is available now
 */
export function remainingCooldownMs(lastHealMs, nowMs) {
  if (!Number.isFinite(lastHealMs)) return 0;
  return Math.max(0, HEAL_COOLDOWN_MS - (nowMs - lastHealMs));
}
