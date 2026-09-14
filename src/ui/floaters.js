/**
 * floaters.js — the number a blow leaves over the thing it hit, MMORPG-style.
 *
 * Same discipline as `callout.js`, for the same reasons: drawn in `#ui-dom-world`
 * (`dom/world.js`) on the design system rather than the bitmap-font HUD canvas, lifetime
 * counted in sim steps rather than wall time so a frozen frame is reproducible
 *, and `projectClient` handed in rather than imported so this file stays
 * free of `three`. `ui/index.js` decides *what* a strike is worth showing (a number, `MISS`, a
 * status, an effectiveness callout) and hands this file only the finished record; this file
 * only times and positions it.
 *
 * **Pop, hold, fade** — the shape every phase of a floater's life is drawn in, all three
 * driven off one continuous `t` (this floater's age over its own `life`, `draw()`'s own
 * comment on where the sub-tick fraction comes from) rather than a CSS `@keyframes` animation:
 * `#ui-dom[data-frozen]` (`css/base.css`) zeroes animation durations for a screenshot capture,
 * which would snap a keyframed floater straight to its end frame instead of holding it at the
 * instant it was frozen.
 */

import { h, setText, syncList } from './dom/el.js';

/** A status effect's own short code, for the status floater — moved here from the (now
 *  removed) battle card, `screens/battle.js`, which used the same map for its transcript
 *  lines. */
export const STATUS_NAME = {
  brn: 'BRN', psn: 'PSN', tox: 'TOX', par: 'PAR', slp: 'SLP', frz: 'FRZ',
};

/** How long a floater is visible, in sim steps — 1.8s at the sim's 20Hz. Long enough for the
 *  pop/hold/fade shape below to read as three distinct beats rather than a blink; short enough
 *  that a busy fight (several floaters a second on the same target) does not turn into a wall
 *  of numbers. */
export const FLOATER_STEPS = 36;
/**
 * A damage number anchors at this fraction of its target's own head lift (`ui/plates.js`'s
 * `headLift`) — mid-body, not the crown. The crown is where the NAMEPLATE sits
 * (`ui/plates.js`'s `POKEMON_LIFT`/`TRAINER_LIFT`), and a floater spawned at that same point
 * used to pop up directly on top of the plate it names; anchoring lower puts it over the
 * sprite's own body, in the clear, and it still rises up past the plate over its life exactly
 * the way a hit number floats up past a health bar in an MMO.
 */
export const FLOATER_LIFT_FRACTION = 0.5;
/** How far it drifts upward over its whole life, in CSS pixels — spent on an ease-out curve
 *  (`draw()`, below) rather than evenly, so most of it happens in the quick "pop" and the rest
 *  reads as a slow drift through the "fade". */
const RISE_PX = 26;
/** The three phases of a floater's life, as fractions of `life`. Pop is a quick scale-in;
 *  hold is the number sitting still and fully legible; fade eases its opacity to zero. */
const POP_FRAC = 0.15;
const HOLD_FRAC = 0.6;
/** Overshoot the pop settles down from — a floater starts a third again larger than its own
 *  resting size and shrinks into place, the same "punch" a crit's own `CRIT_SCALE` reads as
 *  when it settles at 2x instead of 1x. */
const POP_SCALE = 1.35;
/** A critical hit's number is drawn this many times normal size — `.ci-floater--crit`. */
const CRIT_SCALE = 2;
/** Deterministic horizontal spread, in CSS pixels, so several floaters spawned on the same
 *  target back-to-back (a multi-hit move, a fast fight) fan out instead of stacking into one
 *  illegible blob. Keyed off `id`, not `Math.random`, so a frozen showcase capture is still
 *  reproducible. */
const SPREAD_PX = 10;

let nextId = 1;

export function makeFloaters() {
  /** @type {{id:number, text:string, x:number, y:number, z:number, tone:string|null, colour:string|null, scale:number, born:number, life:number}[]} */
  let items = [];
  let step = 0;

  return {
    /**
     * Adds one floater over a world point. Never replaces another — several can stack.
     * `tone` names a `.ci-floater--<tone>` modifier (`crit`, `super`, `weak`, `miss`,
     * `status`, `effectiveness`); `colour` is an escape hatch for a one-off inline colour
     * when no tone fits.
     */
    push({ text, x, y = 0, z, tone = null, colour = null, scale = 1, life = FLOATER_STEPS }) {
      if (!text) return false;
      items.push({ id: nextId++, text: String(text), x, y, z, tone, colour, scale, born: step, life });
      return true;
    },
    /** One sim step. Returns whether a repaint is owed, same contract as `callout.js`. */
    tick(n = 1) {
      if (!items.length) return false;
      step += n;
      items = items.filter((it) => step - it.born < it.life);
      return true;
    },
    clear() { items = []; return true; },
    count: () => items.length,
    peek: () => items.map((it) => ({ ...it })),

    /**
     * Syncs `container`'s children to the live floaters, each rising over its own lifetime.
     *
     * `alpha` is the render frame's own sub-tick fraction (`registry.frame`'s own argument,
     * threaded through `ui/index.js`'s `lateFrame`/`drawWorld`) — folded into `t` so the pop/
     * rise/fade advance smoothly at whatever frame rate is drawing, rather than in the visible
     * ~0.9px steps a plain `step - born` would move in between 20Hz sim ticks. `0` (the
     * default) reproduces the old tick-quantized motion for a caller that has none to give.
     */
    draw(container, projectClient, alpha = 0) {
      if (!container) return;
      if (!items.length || typeof projectClient !== 'function') { container.replaceChildren(); return; }
      syncList(container, items, (it) => it.id,
        () => h('div', { class: 'ci-floater' }),
        (el, it) => {
          const at = projectClient(it.x, it.y, it.z);
          el.hidden = !at || !Number.isFinite(at.x) || !Number.isFinite(at.y);
          if (el.hidden) return;
          const t = Math.min(1, Math.max(0, (step - it.born + alpha) / it.life));

          // Pop: overshoot down to the item's own resting scale. Hold and fade both sit at
          // that resting scale — only opacity moves once the pop has settled.
          const scale = t < POP_FRAC
            ? it.scale * (POP_SCALE - (POP_SCALE - 1) * (t / POP_FRAC))
            : it.scale;
          // Fade: eased (quadratic) so it reads as sitting still through most of `HOLD_FRAC..1`
          // and only visibly dimming in the last beat, rather than a linear fade the eye reads
          // as fading from the moment it spawns.
          const fadeT = t < HOLD_FRAC ? 0 : (t - HOLD_FRAC) / (1 - HOLD_FRAC);
          const opacity = 1 - fadeT * fadeT;
          // Rise: one ease-out curve over the WHOLE life (not phase-split) — fast during the
          // pop, slowing into a drift through the hold and fade, which is what "pop, then a
          // slow continued drift" actually looks like drawn as motion rather than as three
          // disjoint speeds.
          const rise = RISE_PX * (1 - (1 - t) * (1 - t));
          const spread = ((it.id % 3) - 1) * SPREAD_PX;

          el.style.left = `${at.x}px`;
          el.style.top = `${at.y}px`;
          el.style.transform = `translate(-50%, -100%) translate(${spread}px, ${-rise}px) scale(${scale})`;
          el.style.opacity = String(opacity);
          // `tone` may name more than one modifier, space-separated (e.g. `'super
          // effectiveness'` — both the colour and the effectiveness-callout sizing).
          const tones = it.tone ? it.tone.split(' ').filter(Boolean) : [];
          el.className = ['ci-floater', ...tones.map((t2) => `ci-floater--${t2}`)].join(' ');
          el.style.color = it.colour ?? '';
          setText(el, it.text);
        });
    },
  };
}

/** How much bigger a critical hit's number is drawn. Exported so `ui/index.js` need not repeat it. */
export const CRIT_FLOATER_SCALE = CRIT_SCALE;
