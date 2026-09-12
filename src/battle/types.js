// @ts-check
/**
 * The type chart, and the one question every damaging move asks of it.
 *
 * **This is source, not data** (DECISIONS #61). It is ~324 non-neutral entries that have not
 * moved since Gen 6, so fetching and parsing a CSV for it at boot would be cost for nothing —
 * and it would put a network dependency in front of the one part of a battle that can never be
 * allowed to be missing. `selftest.js` pins thirty landmark pairs against it instead.
 *
 * Pure: no ctx, no clock, no DOM, no three. It runs in Node.
 */

/** The eighteen, in the order `collection/dex.js` already lists them. */
export const TYPES = [
  'normal', 'fire', 'water', 'electric', 'grass', 'ice',
  'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug',
  'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
];

const T = new Set(TYPES);

/**
 * Attacker -> defender -> multiplier, listing **only what is not 1**.
 *
 * Written this way round because that is the direction a move is used in, and written sparsely
 * because a full 18x18 grid of mostly-ones is 324 numbers nobody can proofread. A missing
 * entry means neutral, which is also what an unknown type gets.
 */
const CHART = {
  normal:   { rock: 0.5, ghost: 0, steel: 0.5 },
  fire:     { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water:    { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass:    { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice:      { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison:   { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground:   { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying:   { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic:  { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug:      { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock:     { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost:    { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon:   { dragon: 2, steel: 0.5, fairy: 0 },
  dark:     { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel:    { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy:    { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
};

/**
 * How much a move of `atkType` is multiplied by against a defender of `defTypes`.
 *
 * Dual types multiply, so the answer is one of 0, 0.25, 0.5, 1, 2, 4 and nothing else.
 *
 * @param {string} atkType
 * @param {string[]} defTypes
 * @returns {number}
 */
export function effectiveness(atkType, defTypes) {
  const row = CHART[String(atkType ?? '').toLowerCase()];
  if (!row) return 1;
  // A bare string is coerced rather than iterated. `for (const d of 'fire')` walks four
  // CHARACTERS, every lookup misses, and the answer is a confident neutral 1 — which is
  // exactly what the showcase's chart did on its first capture: eighteen by eighteen cells,
  // all of them blank, with nothing throwing and no test failing (the selftest only ever
  // passes arrays). Silent, and wrong in the direction that looks like working code.
  const types = Array.isArray(defTypes) ? defTypes : [defTypes];
  let mult = 1;
  for (const d of types) mult *= row[String(d ?? '').toLowerCase()] ?? 1;
  return mult;
}

/** Same-type attack bonus. Flat 1.5; no Adaptability, because there are no abilities. */
export const STAB = 1.5;

/** Whether a string names one of the eighteen. Used by the selftest and the data loader. */
export const isType = (t) => T.has(String(t ?? '').toLowerCase());

/**
 * One colour triple per type — `core`/`edge` for a strike's own effect, `ink` for its name
 * printed over paper (a balloon, a floater). Canonical: this used to be four independent
 * copies (`encounter/strikes.js`, `ui/panels/dex.js`, `idle/panel.js`,
 * `collection/showcase.js`), and the ask that a balloon colour its move name by type is what
 * made the fourth one land here instead of copying the pattern a fifth time.
 *
 * `core`/`edge` are unchanged from `strikes.js`'s own table — chosen against the mainline's
 * colour language, checked there against this renderer's bloom threshold (DECISIONS #79).
 * `ink` is **derived, not chosen**: `edge`, darkened in equal steps (RGB scaled together, so
 * the hue does not shift) until its WCAG contrast ratio against `C.wallLight` (the balloon's
 * own paper, `#F5E9CE`) clears 4.5:1 — the same threshold this project already cites for a
 * readable pair elsewhere (DECISIONS #77's "5.2:1 to 2.5:1" collapse). Eight of the eighteen
 * needed no darkening at all; `electric`'s raw edge was 1.39:1 against this paper (a lemon
 * yellow on cream) and needed eight steps. `selftest.js` pins the computed ratio, not the
 * hex, so a future palette change cannot reintroduce an unreadable pair silently.
 */
export const TYPE_INK = Object.freeze({
  normal:   { core: '#f2ede0', edge: '#a8a08c', ink: '#6e695c' },
  fire:     { core: '#ffd27a', edge: '#e04d1a', ink: '#ae3b14' },
  water:    { core: '#9fe0ff', edge: '#2f6fd0', ink: '#2b66bf' },
  electric: { core: '#fff29a', edge: '#e8c62c', ink: '#776516' },
  grass:    { core: '#c4f58a', edge: '#4a9a2c', ink: '#397722' },
  ice:      { core: '#d8fbff', edge: '#4fb8d0', ink: '#2f6f7e' },
  fighting: { core: '#ffb08a', edge: '#c03028', ink: '#c03028' },
  poison:   { core: '#e0a8f0', edge: '#8a2f9a', ink: '#8a2f9a' },
  ground:   { core: '#f0dCa0', edge: '#a8813c', ink: '#82642e' },
  flying:   { core: '#e4e0ff', edge: '#8878d8', ink: '#695da8' },
  psychic:  { core: '#ffb0d0', edge: '#d0357a', ink: '#bf3070' },
  bug:      { core: '#dcf08a', edge: '#7a9020', ink: '#5e7018' },
  rock:     { core: '#e8dcc0', edge: '#8a7040', ink: '#745e36' },
  ghost:    { core: '#c8b8f0', edge: '#5a4a90', ink: '#5a4a90' },
  dragon:   { core: '#c0b0ff', edge: '#5030d0', ink: '#5030d0' },
  dark:     { core: '#b0a498', edge: '#4a3c30', ink: '#4a3c30' },
  steel:    { core: '#e4e4f0', edge: '#8a8aa8', ink: '#626278' },
  fairy:    { core: '#ffd0e0', edge: '#d06a90', ink: '#954b67' },
});

/** The triple for a type, falling back to `normal` for anything unrecognised. */
export const typeColour = (t) => TYPE_INK[String(t ?? '').toLowerCase()] ?? TYPE_INK.normal;

/**
 * How a multiplier reads in the message line. `ui` prints this, so the wording lives beside
 * the number rather than being re-derived in the panel.
 */
export function effectivenessText(mult) {
  if (mult === 0) return "It doesn't affect the target…";
  if (mult >= 4) return "It's stupendously effective!";
  if (mult > 1) return "It's super effective!";
  if (mult === 0) return '';
  if (mult <= 0.25) return "It's barely effective…";
  if (mult < 1) return "It's not very effective…";
  return '';
}
