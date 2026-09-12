/**
 * The evolution animation.
 *
 * Evolution uses a button, and a button that silently swaps one sprite for
 * another is a worse moment than the automatic one it replaced — the player pays a hunt's
 * worth of drops for it, so it has to be worth watching.
 *
 * **What it is, and why it is only these three things.** The overworld sprite mesh has no
 * per-instance colour: `field.js` patches a `aUvRect` attribute and nothing else, so there is
 * no tint to flash white with and no opacity to fade. What an actor *does* expose is `key`
 * (which sheet it is reading), `scale` and `visible` — so the animation is built out of
 * exactly those:
 *
 *   1. **the alternation**, old form / new form, accelerating from 0.30 s to 0.05 s. This is
 *      the mainline's own idea and it survives being drawn at 32 px, which the mainline's
 *      white silhouette would not: a 32-px sprite flooded to one colour is a blob.
 *   2. **a blink** of one frame at each swap. It stands in for the flash, and it is what stops
 *      the alternation reading as a stutter — two sprites cutting between each other with no
 *      gap looks like a dropped frame, which is the thing this must not look like.
 *   3. **the pop** at the end: the new form overshoots to 1.35 and settles, so the sequence
 *      lands on something rather than just stopping.
 *
 * Driven from `pokemon`'s `lateFrame`, which already runs after `simulation` has posed every
 * walker — and the pose patch sets position, direction and gait but never `key` or `scale`, so
 * the two do not fight. Checked rather than assumed: `poseWalker` builds
 * `{ x, y, z, dir, visible, gait, phase }` and nothing else.
 *
 * Timing is in **seconds of real time**, not sim steps: this is presentation, it must not
 * change what the world does, and a frozen clock (`?timeFrozen=1`) must leave it alone so a
 * screenshot of an evolving Pokemon is reproducible.
 */

/** How long the whole thing takes. Long enough to read, short enough to sit through. */
export const ALTERNATE_S = 2.0;
export const POP_S = 0.5;
export const TOTAL_S = ALTERNATE_S + POP_S;

/** The swap interval eases from slow to frantic across the alternation. */
const SLOW_SWAP = 0.30;
const FAST_SWAP = 0.05;

/** One frame of nothing at each swap — the stand-in for the mainline's white flash. */
const BLINK_S = 1 / 30;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * How many swaps have happened by time `t`, and how far into the current one we are.
 *
 * The interval shrinks quadratically, so the sequence is unmistakably *accelerating* rather
 * than merely fast — a linear ramp reads as a constant flicker for most of its length.
 * Integrated by stepping rather than solved in closed form: it runs a few dozen times per
 * evolution, and the loop is the thing a reader can check against the constants above.
 */
export function swapsBy(t) {
  let elapsed = 0;
  let n = 0;
  for (let guard = 0; guard < 512; guard++) {
    const k = clamp01(elapsed / ALTERNATE_S);
    const step = SLOW_SWAP + (FAST_SWAP - SLOW_SWAP) * (k * k);
    if (elapsed + step > t) return { n, into: t - elapsed, step };
    elapsed += step;
    n++;
  }
  return { n, into: 0, step: FAST_SWAP };
}

/**
 * The whole animation as a pure function of time: which sheet, how big, and whether it is
 * visible at all this frame.
 *
 * Pure so the selftest can assert the shape of it — that it starts on the old form, ends on
 * the new one, never leaves the actor hidden, and never returns a scale that would put a
 * sprite through the floor.
 *
 * @param {number} t seconds since the evolution started
 * @returns {{ showNew:boolean, scale:number, visible:boolean, done:boolean }}
 */
export function frameAt(t) {
  if (t >= TOTAL_S) return { showNew: true, scale: 1, visible: true, done: true };

  if (t < ALTERNATE_S) {
    const { n, into, step } = swapsBy(t);
    // A pulse per swap, decaying across it, so the sprite breathes with the rhythm instead of
    // sitting still while the sheets cut underneath it.
    const pulse = 1 + 0.10 * (1 - clamp01(into / step));
    return {
      showNew: n % 2 === 1,
      scale: pulse,
      visible: into > BLINK_S,
      done: false,
    };
  }

  // The pop: overshoot to 1.35 and settle back, on the new form.
  const k = clamp01((t - ALTERNATE_S) / POP_S);
  const overshoot = Math.sin(k * Math.PI) * 0.35;
  return { showNew: true, scale: 1 + overshoot, visible: true, done: false };
}

/**
 * Runs one evolution on one actor.
 *
 * Takes the two atlas keys rather than resolving them itself: whoever calls this has already
 * had to `prepare` both sheets (the new form's is not in the atlas until somebody asks for
 * it), and a function that both loads and animates would be two jobs and one of them async.
 *
 * @param {object} field  the SpriteField
 * @param {number} actorId
 * @param {{key:string, frameTexels:number}} from
 * @param {{key:string, frameTexels:number}} to
 */
export function makeEvolution(field, actorId, from, to) {
  let t = 0;
  const actor = field.get(actorId);
  // The scale it was already drawn at — a giant (`sheet.frame === 64`) is spawned scaled and
  // must not be snapped to 1 by an animation that assumed everything is the same size.
  const base = actor?.scale ?? 1;

  return {
    actorId,
    /** @returns {boolean} still running */
    step(dt) {
      t += Math.max(0, dt);
      const f = frameAt(t);
      const side = f.showNew ? to : from;
      field.set(actorId, {
        key: side.key,
        frameTexels: side.frameTexels,
        // `set` only recomputes w/h when `scale` is in the patch, so scale goes with every
        // key change whether it moved or not.
        scale: base * f.scale,
        visible: f.visible,
      });
      if (f.done) {
        field.set(actorId, { key: to.key, frameTexels: to.frameTexels, scale: base, visible: true });
        return false;
      }
      return true;
    },
    /** Lands on the finished state immediately. Used when the scene is torn down mid-flash. */
    finish() {
      field.set(actorId, { key: to.key, frameTexels: to.frameTexels, scale: base, visible: true });
    },
  };
}
