/**
 * callout.js — the line a trainer shouts over a fight, and the wild's own answer.
 *
 * The brief asks that "the trainer visibly calls out the moves used by their Pokémon" and that
 * "the wild Pokémon's moves should also be shown during combat", with a balloon over each
 * speaker's head, an arrow tying it to who said it, and the move's own name coloured by its
 * type (the balloon's paper stays neutral — only the move name takes the colour, so a bright
 * type does not turn the whole balloon into a wash nobody can read). That is *text over a place
 * in the world*, which is a shape this project did not have: `ui` is a HUD anchored to the
 * screen and everything in the world is a textured quad.
 *
 * **Drawn in `#ui-dom-world`** (`dom/world.js`), on the design system — `.ci-balloon`
 * (`css/world.css`), positioned every frame with `left`/`top` off `ui/index.js`'s
 * `projectClient()` (real, viewport CSS pixels through `view.displayRect`). Text at real
 * resolution, in the project's own type and colour tokens, is what a soft-UI balloon over a
 * DS-pixel world needs — the reasoning `screen.js`'s own header gives for the debug overlay
 * staying canvas is exactly the reasoning that put every other panel in `#ui-dom` starting
 * Stage 1, and a battle balloon is a panel like any other.
 *
 * **Its lifetime is counted in sim steps**, like every other beat `encounter` owns, so a frozen
 * frame is reproducible and a screenshot of turn three is the same picture every time
 *.
 */

import { h, setText, syncList } from './dom/el.js';

/** How long a line hangs there, in sim steps (1/20 s). Just under one exchange. */
export const CALLOUT_STEPS = 22;

export function makeCallouts() {
  /** @type {{name:string, verb:string, move:string, ink:string, x:number, y:number, z:number, side:string, born:number, life:number}[]} */
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
     * `name`, `verb` and `move` print as three runs — `"{name} {verb} {move}"` — `name`/`verb`
     * in the ordinary ink, `move` in `ink` (the type's own — `battle.typeColour(type).ink`,
     * resolved by the caller so this file stays free of `battle`). `verb` is what tells a
     * player's own Pokemon ("use") from a wild's ("uses") — the caller's call, not a guess
     * made here. A line with no `move` (a swap's "I choose you!", a status) prints `name`
     * alone, whole, in the ordinary ink.
     */
    say({ name, verb = null, move = null, ink = null, x, y = 0, z, side = 'a', life = CALLOUT_STEPS }) {
      if (!name) return false;
      lines = lines.filter((l) => l.side !== side);
      lines.push({ name: String(name), verb, move, ink, x, y, z, side, born: step, life });
      return true;
    },
    /**
     * One sim step. Answers whether a repaint is owed: false when nothing is up, true
     * otherwise — a live callout can expire between two DOM syncs, so any step with one alive
     * is a changed frame even when none expired this tick.
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
     * Syncs `container`'s children to the live lines, one `.ci-balloon-anchor` per side (at
     * most two: `say()` replaces rather than stacks). `projectClient` is handed in rather than
     * imported, so this file stays free of `three`.
     */
    draw(container, projectClient) {
      if (!container) return;
      if (!lines.length || typeof projectClient !== 'function') { container.replaceChildren(); return; }
      syncList(container, lines, (l) => l.side,
        () => {
          // The tail is a CHILD of the balloon (not a sibling under the zero-size anchor
          // anymore) — it has to move with the balloon's own `--lean` offset so its base stays
          // glued to the balloon's bottom border instead of floating off toward the true head.
          // What still keeps the tail's tip pointed at the real anchor point is geometry, not
          // DOM position: `world.css`'s `.ci-balloon` insets its NEAR corner by a fixed amount
          // instead of leaning its far edge out, so the anchor's `(0,0)` origin always falls
          // inside that near corner, and the tail is placed by that same inset so its rotated
          // tip lands back on it exactly. See `world.css`'s own comment for the arithmetic.
          const move = h('span', { class: 'ci-balloon__move' });
          const body = h('span', { class: 'ci-balloon__body' });
          const tail = h('div', { class: 'ci-balloon__tail' });
          const balloon = h('div', { class: 'ci-balloon' }, [body, move, tail]);
          return h('div', { class: 'ci-balloon-anchor' }, [balloon]);
        },
        (el, l) => {
          const at = projectClient(l.x, l.y, l.z);
          el.hidden = !at || !Number.isFinite(at.x) || !Number.isFinite(at.y);
          if (el.hidden) return;
          el.style.left = `${at.x}px`;
          el.style.top = `${at.y}px`;
          const [balloon] = el.children;
          const [body, move] = balloon.children;
          // **The two sides lean apart, and that is not decoration.** A sprite is 2.83 world
          // units tall, which under the 45-degree camera is exactly two tiles of ground depth
          // — and `encounter` stages the wild two cells in front of the party's Pokemon. So a
          // balloon anchored at the wild's own head lands close to where the Pokemon is
          // standing too; leaning the ally's line left and the wild's right (`--lean` in
          // `world.css`) separates them. `data-side` mirrors the same split for the CSS that
          // places the now-nested tail off the balloon's near corner.
          balloon.style.setProperty('--lean', l.side === 'b' ? '1' : '-1');
          balloon.dataset.side = l.side === 'b' ? 'b' : 'a';
          if (l.move) {
            // The trailing space is deliberate — `body` and `move` are adjacent inline runs
            // with no separator of their own between them.
            setText(body, `${l.name} ${l.verb ?? 'uses'} `);
            setText(move, l.move);
            move.hidden = false;
            move.style.color = l.ink ?? '';
          } else {
            setText(body, l.name);
            move.hidden = true;
          }
          // Clamp the balloon's own resting spot into the viewport, never the anchor: the
          // anchor has to stay at the true projected head position or the tail stops pointing
          // at anything real. Reset `--nudge` first so a *previous* frame's clamp doesn't bias
          // this frame's measurement (a balloon that scrolled back on-screen must be able to
          // let go of its old nudge), then measure and re-clamp against the fresh box. At most
          // two balloons ever exist (see this file's own header comment), so a layout read per
          // side per frame is cheap.
          balloon.style.setProperty('--nudge', '0px');
          const rect = balloon.getBoundingClientRect();
          const overflowLeft = Math.max(0, 8 - rect.left);
          const overflowRight = Math.max(0, rect.right - (window.innerWidth - 8));
          if (overflowLeft > 0) balloon.style.setProperty('--nudge', `${overflowLeft}px`);
          else if (overflowRight > 0) balloon.style.setProperty('--nudge', `${-overflowRight}px`);
        });
    },
  };
}
