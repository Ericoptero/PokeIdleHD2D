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
 */

import { h, setText, syncList } from './dom/el.js';

/** A status effect's own short code, for the status floater — moved here from the (now
 *  removed) battle card, `screens/battle.js`, which used the same map for its transcript
 *  lines. */
export const STATUS_NAME = {
  brn: 'BRN', psn: 'PSN', tox: 'TOX', par: 'PAR', slp: 'SLP', frz: 'FRZ',
};

/** How long a floater is visible, in sim steps. Long enough to read, short enough that a busy
 *  fight (several floaters a second on the same target) does not turn into a wall of numbers. */
export const FLOATER_STEPS = 24;
/** How far it drifts upward over its life, in CSS pixels. */
const RISE_PX = 22;
/** A critical hit's number is drawn this many times normal size — `.ci-floater--crit`. */
const CRIT_SCALE = 2;

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

    /** Syncs `container`'s children to the live floaters, each rising over its own lifetime. */
    draw(container, projectClient) {
      if (!container) return;
      if (!items.length || typeof projectClient !== 'function') { container.replaceChildren(); return; }
      syncList(container, items, (it) => it.id,
        () => h('div', { class: 'ci-floater' }),
        (el, it) => {
          const at = projectClient(it.x, it.y, it.z);
          el.hidden = !at || !Number.isFinite(at.x) || !Number.isFinite(at.y);
          if (el.hidden) return;
          const t = Math.min(1, (step - it.born) / it.life);
          el.style.left = `${at.x}px`;
          el.style.top = `${Math.round(at.y - RISE_PX * t)}px`;
          // `tone` may name more than one modifier, space-separated (e.g. `'super
          // effectiveness'` — both the colour and the effectiveness-callout sizing).
          const tones = it.tone ? it.tone.split(' ').filter(Boolean) : [];
          el.className = ['ci-floater', ...tones.map((t) => `ci-floater--${t}`)].join(' ');
          el.style.color = it.colour ?? '';
          setText(el, it.text);
        });
    },
  };
}

/** How much bigger a critical hit's number is drawn. Exported so `ui/index.js` need not repeat it. */
export const CRIT_FLOATER_SCALE = CRIT_SCALE;
