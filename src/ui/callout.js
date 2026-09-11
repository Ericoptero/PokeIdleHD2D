/**
 * callout.js — the line a trainer shouts over a fight.
 *
 * The brief asks that "the trainer visibly calls out the moves used by their Pokémon" and that
 * "the wild Pokémon's moves should also be shown during combat". That is *text over a place in
 * the world*, which is a shape this project did not have: `ui` is a HUD anchored to the screen
 * (DECISIONS #34a) and everything in the world is a textured quad.
 *
 * **It is drawn on the HUD canvas, not in the scene**, and the reason is arithmetic rather than
 * convenience. Text in 3-D would need a second font atlas as a texture, one draw call per
 * balloon, and its own filtering story. Projected onto the 2-D canvas it costs **zero draw
 * calls**, reuses the bitmap font and the panel art the rest of the UI is made of, and — because
 * the camera is orthographic and the UI canvas is exactly the renderer's internal buffer
 * (§2.7, `screen.js`) — the projection is exact and lands on the same pixel grid the world
 * does. There is no depth divide to make the balloon disagree with the sprite under it.
 *
 * **Its lifetime is counted in sim steps**, like every other beat `encounter` owns, so a frozen
 * frame is reproducible and a screenshot of turn three is the same picture every time
 * (DECISIONS #14).
 */

import { C, panel } from './theme.js';

/** How long a line hangs there, in sim steps (1/20 s). Just under one exchange. */
export const CALLOUT_STEPS = 22;

/**
 * How far above the speaker's feet the balloon floats, in world units.
 *
 * **3.1, and the number is measured rather than chosen.** A 32-texel sprite is 16 texels per
 * world unit stretched by `1/cos(45°)` (DECISIONS #18), so it stands 2.83 units tall — at 2.15
 * the balloon landed across the middle of the Pokemon that was speaking and hid it. 3.1 clears
 * the head with a quarter-tile of air, and still sits under the "!" balloon's own ceiling.
 */
const LIFT = 3.1;

export function makeCallouts() {
  /** @type {{text:string, x:number, y:number, z:number, side:string, born:number, life:number}[]} */
  let lines = [];
  let step = 0;

  return {
    /** Says one line over a world position. A second line from the same side replaces the first. */
    say({ text, x, y = 0, z, side = 'a', life = CALLOUT_STEPS }) {
      if (!text) return false;
      lines = lines.filter((l) => l.side !== side);
      lines.push({ text: String(text), x, y: y + LIFT, z, side, born: step, life });
      return true;
    },
    /**
     * One sim step. Answers whether the canvas needs a repaint: false when nothing is up,
     * true otherwise — a live callout drifts and fades every step, so any step with one alive
     * is a changed frame even when none expired.
     */
    tick(n = 1) {
      if (!lines.length) return false;
      step += n;
      lines = lines.filter((l) => step - l.born < l.life);
      return true;
    },
    clear() { lines = []; return true; },
    count: () => lines.length,
    peek: () => lines.map((l) => ({ ...l })),

    /**
     * Paints every live line, projecting each world anchor through the camera.
     *
     * `project` is handed in rather than imported, so this file stays free of `three` and can
     * be reasoned about (and, one day, checked) without a renderer.
     */
    draw(g, project) {
      if (!lines.length || typeof project !== 'function') return;
      for (const l of lines) {
        const at = project(l.x, l.y, l.z);
        // Behind the camera, or off the buffer entirely: say nothing rather than clamping a
        // balloon to an edge it does not belong to.
        if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
        const w = Math.min(g.width - 8, g.measure(l.text) + 10);
        const h = 12;
        // Centred on the speaker and nudged inside the frame, because a creature at the edge of
        // the screen still has something to say.
        // **The two sides lean apart, and that is not decoration.** A sprite is 2.83 world
        // units tall, which under the 45-degree camera is exactly two tiles of ground depth
        // (DECISIONS #18) — and `encounter` stages the wild two cells in front of the party's
        // Pokemon. So a balloon lifted clear of the wild's head lands precisely where the
        // Pokemon is standing, every time, and no vertical lift can separate them. Leaning the
        // ally's line left and the wild's right does, and it reads the way a fight should.
        const lean = (l.side === 'b' ? 1 : -1) * (w / 2 + 6);
        const x = Math.round(Math.max(4, Math.min(g.width - w - 4, at.x - w / 2 + lean)));
        const y = Math.round(Math.max(2, Math.min(g.height - h - 2, at.y - h)));
        panel(g, { x, y, w, h }, { paper: C.wallLight, edge: C.woodShadow, bevel: false, drop: true });
        g.text(x + 5, y + 3, l.text, C.ink, { max: w - 10 });
      }
    },
  };
}
