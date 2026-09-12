/**
 * elements.js — the personality of a strike, decoupled from its colour.
 *
 * `battle.typeColour(type)` (DECISIONS #87) gives the eighteen types their `core`/`edge`/`ink`
 * — that is *what colour* a type is. This file is *how it moves*: without it, fire, water and
 * psychic would read as three recolourings of the same star, which is exactly the defect
 * DECISIONS #79 recorded in the system this replaces (291 contact moves sharing one sprite).
 * `PROFILE` crosses a **motion law** (how the particle field behaves over a strike) with a
 * **particle role** (what the individual mote looks like) and an **intensity** (how much of
 * it). Pure data and pure functions — no `three`, no `ctx`, so it is testable under plain
 * vitest and reusable by `particles.js`, `beams.js` and `ground.js` alike.
 *
 * `shapeOf` and `STATUS_CATEGORY`/`PHYSICAL_CATEGORY` are moved here unchanged from the system
 * this replaces (`strikes.js`, deleted this slice) — the shape a move is drawn as is a
 * property of its delivery, not of its look, so it belongs beside the beat timeline that reads
 * it, not beside the colour table.
 */

/** Physical / special / status, as `battle/moves.js` numbers them. */
const STATUS_CATEGORY = 0;
const PHYSICAL_CATEGORY = 1;

/**
 * Which of the three shapes a move is drawn as, read off the move record rather than a name
 * list, so a move added to `moves.json` tomorrow is covered tomorrow.
 */
export function shapeOf(move) {
  if (!move) return 'contact';
  if (move.c === STATUS_CATEGORY) return 'field';
  return move.c === PHYSICAL_CATEGORY ? 'contact' : 'projectile';
}

/** How the particle field behaves over the life of a strike. */
export const MOTION = Object.freeze({
  RISE: 'rise', FALL: 'fall', ZIGZAG: 'zigzag', ORBIT: 'orbit', SPIRAL: 'spiral',
});

/** What an individual mote looks like, drawn procedurally in `particles.js`'s fragment shader. */
export const ROLE = Object.freeze({
  SPARK: 'spark', EMBER: 'ember', SHARD: 'shard', DROPLET: 'droplet', LEAF: 'leaf', DUST: 'dust',
});

/**
 * Eighteen personalities. Grouped by kinship rather than invented per type — a family of
 * types that already share a mainline identity (the two "debris" types, the two "swirl"
 * types) share a motion law, which is what keeps the crossing legible rather than arbitrary.
 */
export const PROFILE = Object.freeze({
  normal:   { motion: MOTION.RISE,   role: ROLE.DUST,    intensity: 0.7 },
  fire:     { motion: MOTION.RISE,   role: ROLE.EMBER,   intensity: 1.15 },
  water:    { motion: MOTION.FALL,   role: ROLE.DROPLET, intensity: 1.0 },
  electric: { motion: MOTION.ZIGZAG, role: ROLE.SPARK,   intensity: 1.2 },
  grass:    { motion: MOTION.RISE,   role: ROLE.LEAF,    intensity: 0.9 },
  ice:      { motion: MOTION.FALL,   role: ROLE.SHARD,   intensity: 1.0 },
  fighting: { motion: MOTION.FALL,   role: ROLE.DUST,    intensity: 1.1 },
  poison:   { motion: MOTION.RISE,   role: ROLE.DROPLET, intensity: 0.85 },
  ground:   { motion: MOTION.FALL,   role: ROLE.SHARD,   intensity: 1.1 },
  flying:   { motion: MOTION.ORBIT,  role: ROLE.DUST,    intensity: 0.9 },
  psychic:  { motion: MOTION.ORBIT,  role: ROLE.SPARK,   intensity: 1.0 },
  bug:      { motion: MOTION.ZIGZAG, role: ROLE.DUST,    intensity: 0.85 },
  rock:     { motion: MOTION.FALL,   role: ROLE.SHARD,   intensity: 1.15 },
  ghost:    { motion: MOTION.SPIRAL, role: ROLE.EMBER,   intensity: 0.9 },
  dragon:   { motion: MOTION.SPIRAL, role: ROLE.SPARK,   intensity: 1.2 },
  dark:     { motion: MOTION.FALL,   role: ROLE.DUST,    intensity: 0.9 },
  steel:    { motion: MOTION.FALL,   role: ROLE.SHARD,   intensity: 1.0 },
  fairy:    { motion: MOTION.ORBIT,  role: ROLE.SPARK,   intensity: 0.95 },
});

/** A type's profile, falling back to `normal` for anything unrecognised. */
export const profileFor = (type) => PROFILE[String(type ?? '').toLowerCase()] ?? PROFILE.normal;

/**
 * Numeric encodings for the shader uniforms `uMotion`/`uRole` — plain integers, since a GLSL
 * uniform has no notion of a string. Order is arbitrary; only `elements.js` and `particles.js`
 * need to agree on it, and both import these maps rather than hard-coding the numbers twice.
 */
export const MOTION_CODE = Object.freeze({
  [MOTION.RISE]: 0, [MOTION.FALL]: 1, [MOTION.ZIGZAG]: 2, [MOTION.ORBIT]: 3, [MOTION.SPIRAL]: 4,
});
export const ROLE_CODE = Object.freeze({
  [ROLE.SPARK]: 0, [ROLE.EMBER]: 1, [ROLE.SHARD]: 2, [ROLE.DROPLET]: 3, [ROLE.LEAF]: 4, [ROLE.DUST]: 5,
});

/**
 * The four-beat timeline, in strike-phase `[0,1]`, per delivery shape — charge at the
 * attacker, delivery (the travel/sweep/growth that differs by shape), impact (the burst) and
 * resolve (the fade). Covers `[0,1]` with no gap and no overlap; `src/encounter/selftest.js`
 * pins this property so a future retune cannot silently open a hole a strike could freeze in.
 */
export const BEATS = Object.freeze({
  contact: [
    { name: 'charge', from: 0, to: 0.15 },
    { name: 'deliver', from: 0.15, to: 0.40 },
    { name: 'impact', from: 0.40, to: 0.70 },
    { name: 'resolve', from: 0.70, to: 1 },
  ],
  projectile: [
    { name: 'charge', from: 0, to: 0.10 },
    { name: 'deliver', from: 0.10, to: 0.65 },
    { name: 'impact', from: 0.65, to: 0.85 },
    { name: 'resolve', from: 0.85, to: 1 },
  ],
  field: [
    { name: 'charge', from: 0, to: 0.10 },
    { name: 'deliver', from: 0.10, to: 0.55 },
    { name: 'impact', from: 0.55, to: 0.80 },
    { name: 'resolve', from: 0.80, to: 1 },
  ],
});

/** The beat a phase falls in, plus how far through that beat it is, in `[0,1]`. */
export function beatAt(shape, phase) {
  const list = BEATS[shape] ?? BEATS.contact;
  const p = phase < 0 ? 0 : phase > 1 ? 1 : phase;
  for (const b of list) {
    if (p < b.to || b === list[list.length - 1]) {
      const span = Math.max(1e-6, b.to - b.from);
      return { name: b.name, k: Math.min(1, Math.max(0, (p - b.from) / span)) };
    }
  }
  return { name: list[list.length - 1].name, k: 1 };
}
