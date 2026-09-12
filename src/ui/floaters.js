/**
 * floaters.js — the number a blow leaves over the thing it hit, MMORPG-style.
 *
 * Same discipline as `callout.js`, for the same reasons: drawn on the HUD canvas rather than
 * in the scene (zero draw calls, the exact orthographic projection, the same bitmap font),
 * lifetime counted in sim steps rather than wall time so a frozen frame is reproducible
 *, and `project` handed in rather than imported so this file stays free of
 * `three`. `ui/index.js` decides *what* a strike is worth showing (a number, `MISS`, a status)
 * and hands this file only the finished record; this file only times and draws it.
 */

import { C } from './theme.js';

/** How long a floater is visible, in sim steps. Long enough to read, short enough that a busy
 *  fight (several floaters a second on the same target) does not turn into a wall of numbers. */
export const FLOATER_STEPS = 24;
/** How far it drifts upward over its life, in internal pixels. */
const RISE_PX = 14;
/** A critical hit's number is drawn this many times normal size. */
const CRIT_SCALE = 2;

export function makeFloaters() {
  /** @type {{text:string, x:number, y:number, z:number, colour:string, scale:number, born:number, life:number}[]} */
  let items = [];
  let step = 0;

  return {
    /** Adds one floater over a world point. Never replaces another — several can stack. */
    push({ text, x, y = 0, z, colour = C.ink, scale = 1, life = FLOATER_STEPS }) {
      if (!text) return false;
      items.push({ text: String(text), x, y, z, colour, scale, born: step, life });
      return true;
    },
    /** One sim step. Returns whether the canvas needs a repaint, same contract as `callout.js`. */
    tick(n = 1) {
      if (!items.length) return false;
      step += n;
      items = items.filter((it) => step - it.born < it.life);
      return true;
    },
    clear() { items = []; return true; },
    count: () => items.length,
    peek: () => items.map((it) => ({ ...it })),

    /** Paints every live floater, rising over its own lifetime. */
    draw(g, project) {
      if (!items.length || typeof project !== 'function') return;
      for (const it of items) {
        const at = project(it.x, it.y, it.z);
        if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
        const t = Math.min(1, (step - it.born) / it.life);
        const py = Math.round(at.y - RISE_PX * t);
        const scale = Math.max(1, Math.round(it.scale));
        const w = g.measure(it.text) * scale;
        const px = Math.round(Math.max(2, Math.min(g.width - w - 2, at.x - w / 2)));
        if (scale > 1) g.textScaled(px, py, it.text, it.colour, scale, { shadow: 'rgba(20,16,12,0.55)' });
        else g.text(px, py, it.text, it.colour, { shadow: 'rgba(20,16,12,0.55)' });
      }
    },
  };
}

/** How much bigger a critical hit's number is drawn. Exported so `ui/index.js` need not repeat it. */
export const CRIT_FLOATER_SCALE = CRIT_SCALE;
