/**
 * callout.js — the line a trainer shouts over a fight, and the wild's own answer.
 *
 * The brief asks that "the trainer visibly calls out the moves used by their Pokémon" and that
 * "the wild Pokémon's moves should also be shown during combat", with a balloon over each
 * speaker's head, an arrow tying it to who said it, and the move's own name coloured by its
 * type (the balloon's paper stays neutral — only the move name takes the colour, so a bright
 * type does not turn the whole balloon into a wash nobody can read). That is *text over a place
 * in the world*, which is a shape this project did not have: `ui` is a HUD anchored to the
 * screen (DECISIONS #34a) and everything in the world is a textured quad.
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

/** How tall the tail is, in px, and how far its tip clears the anchor point beneath it. */
const TAIL_H = 4;
const TAIL_GAP = 2;

export function makeCallouts() {
  /** @type {{name:string, move:string, ink:string, x:number, y:number, z:number, side:string, born:number, life:number}[]} */
  let lines = [];
  let step = 0;

  return {
    /**
     * Says one line over a world position. A second line from the same side replaces the
     * first. `x,y,z` is the point the balloon's tail points *at* — the caller lifts it clear
     * of the head already (`ui/plates.js`'s own `POKEMON_LIFT`/`TRAINER_LIFT`, plus a margin
     * for the plate now living there too), because only the caller knows which of the two this
     * speaker is.
     *
     * `name` and `move` are printed as two runs, `name` in the ordinary ink and `move` in
     * `ink` (the type's own — `battle.typeColour(type).ink`, resolved by the caller so this
     * file stays free of `battle`). A line with no `move` (a struggle, a status) prints `name`
     * alone in the ordinary ink.
     */
    say({ name, move = null, ink = null, x, y = 0, z, side = 'a', life = CALLOUT_STEPS }) {
      if (!name) return false;
      lines = lines.filter((l) => l.side !== side);
      lines.push({ name: String(name), move, ink, x, y, z, side, born: step, life });
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

        const moveW = l.move ? g.measure(`${l.move}!`) : 0;
        const nameW = g.measure(l.move ? `${l.name}:` : l.name);
        const text = moveW ? nameW + 3 + moveW : nameW;
        const w = Math.min(g.width - 8, text + 10);
        const h = 12;
        // Centred on the speaker and nudged inside the frame, because a creature at the edge of
        // the screen still has something to say.
        // **The two sides lean apart, and that is not decoration.** A sprite is 2.83 world
        // units tall, which under the 45-degree camera is exactly two tiles of ground depth
        // (DECISIONS #18) — and `encounter` stages the wild two cells in front of the party's
        // Pokemon. So a balloon lifted clear of the wild's head lands precisely where the
        // Pokemon is standing, every time, and no vertical lift can separate them. Leaning the
        // ally's line left and the wild's right does, and it reads the way a fight should — and
        // the tail (below) still points at the true anchor, so the lean never reads as a balloon
        // belonging to the wrong speaker.
        const lean = (l.side === 'b' ? 1 : -1) * (w / 2 + 6);
        const x = Math.round(Math.max(4, Math.min(g.width - w - 4, at.x - w / 2 + lean)));
        const y = Math.round(Math.max(2 + TAIL_H + TAIL_GAP, Math.min(g.height - h - 2, at.y - h - TAIL_H - TAIL_GAP)));

        panel(g, { x, y, w, h }, { paper: C.wallLight, edge: C.woodShadow, bevel: false, drop: true });

        // The tail, drawn *after* the panel (and its own drop shadow) rather than before —
        // `drop: true` shades a strip right where the tail sits, and drawing under it left the
        // tail's top row eaten by the panel's own shadow on the first cut of this.  A small
        // downward-narrowing notch, anchored at the *true* projected point (clamped inside the
        // balloon's own width) so a leaned balloon still visibly belongs to its speaker rather
        // than to whatever happens to be under its centre.
        const tipX = Math.round(Math.max(x + 4, Math.min(x + w - 4, at.x)));
        for (let row = 0; row < TAIL_H; row++) {
          const rw = Math.max(1, (TAIL_H - row) * 2 - 1);
          g.fill(tipX - Math.floor(rw / 2), y + h + row, rw, 1, row === 0 ? C.woodShadow : C.wallLight);
        }
        // The tail's own outline, so it does not read as a paper-coloured blob with no edge.
        g.fill(tipX - Math.floor(TAIL_H / 2) - 1, y + h, 1, TAIL_H, C.woodShadow);
        g.fill(tipX + Math.floor(TAIL_H / 2), y + h, 1, TAIL_H, C.woodShadow);

        if (l.move) {
          const after = g.text(x + 5, y + 3, `${l.name}:`, C.ink, { max: nameW });
          g.text(after + 3, y + 3, `${l.move}!`, l.ink ?? C.ink, { max: moveW });
        } else {
          g.text(x + 5, y + 3, l.name, C.ink, { max: w - 10 });
        }
      }
    },
  };
}
