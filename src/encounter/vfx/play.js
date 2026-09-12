/**
 * play.js — the strike's own timeline, and the API `encounter/index.js` actually calls.
 *
 * Keeps the exact contract `strikes.js` (deleted this slice) already offered —
 * `play({shape,type,from,to})` / `phase(p)` / `hide()` / `playing()` / `dispose()` — so the
 * caller's own changes are an import swap, not a rewrite. One exception: **no `refit()`**.
 * The old system billboarded by copying the camera's quaternion onto each mesh once a
 * rendered frame; every mesh here billboards by adding its local offset in *view* space
 * after `modelViewMatrix` (`particles.js`, `beams.js` — the same trick `environment/weather.js`
 * already uses), which is already correct for whatever camera the renderer draws with this
 * frame, with nothing to repeat. `ground.js`'s ring lies flat and never billboarded even in
 * the old system. `encounter/index.js`'s own `refit()` still exists, for `ball.js`'s sprite.
 *
 * Colour comes from `battle.typeColour(type)` (DECISIONS #90) — `core`/`edge`, read live and
 * `isLive`-guarded exactly like `emitStrike` already reads `battle` for the same strike, with
 * a neutral fallback for the moment `battle` itself is quarantined. Movement personality comes
 * from `elements.js`'s `profileFor(type)`. Neither file needs to know about the other.
 */

import { profileFor, shapeOf, BEATS, beatAt, MOTION_CODE, ROLE_CODE } from './elements.js';
import { makeParticleField } from './particles.js';
import { makeBeam } from './beams.js';
import { makeGroundRing } from './ground.js';

export { shapeOf };

const isLive = (api) => !!api && api.__missing === undefined;
const FALLBACK_COLOUR = { core: '#f2ede0', edge: '#a8a08c' };
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const beatOf = (shape, name) => (BEATS[shape] ?? BEATS.contact).find((b) => b.name === name);

/** A beat's own local progress `[0,1]`, given the strike's overall phase. */
function localK(beat, p) {
  if (p < beat.from) return 0;
  if (p >= beat.to) return 1;
  return (p - beat.from) / Math.max(1e-6, beat.to - beat.from);
}

/**
 * Builds the three sub-effects and hands back the phase-driven API `encounter/index.js` calls.
 *
 * `pitch`/`_opts` are accepted for call-site compatibility with the system this replaces
 * (`makeStrikeVfx(ctx.THREE, ctx, { pitch: config.cameraPitch ?? 45 })`) but unused: nothing
 * here paints a pixel-art texture at a texel density that would need the sprite stretch
 * DECISIONS #18 exists for, so there is no pitch-dependent geometry left to compute.
 */
export function makeStrikeVfx(THREE, ctx, _opts = {}) {
  const scene = ctx.three.scene;
  const particles = makeParticleField(THREE, scene);
  const beam = makeBeam(THREE, scene);
  const ground = makeGroundRing(THREE, scene);

  /** @type {{shape:string, type:string, from:object, to:object, crit:boolean, effectiveness:number}|null} */
  let live = null;

  const colourFor = (type) => {
    const bt = ctx.get?.('battle');
    if (isLive(bt) && typeof bt.typeColour === 'function') {
      const c = bt.typeColour(type);
      if (c?.core && c?.edge) return c;
    }
    return FALLBACK_COLOUR;
  };

  const hideAll = () => { particles.hide(); beam.hide(); ground.hide(); };

  return {
    /**
     * Stages one strike. `from`/`to` are world points — the attacker's feet and the target's.
     * `crit`/`effectiveness` are optional (default to no crit, neutral effectiveness) so a
     * caller that does not know them yet (or a showcase staging a bare shape/type) still gets
     * a played effect, just without the two beats they add.
     */
    play({ shape, type, from, to, crit = false, effectiveness = 1 }) {
      live = { shape: BEATS[shape] ? shape : 'contact', type, from, to, crit, effectiveness };
      return true;
    },

    /** Draws the strike at `p` in `[0,1]`. Pure: the same `p` gives the same pixels, so a
     *  frozen showcase frame is reproducible (DECISIONS #14). */
    phase(pRaw) {
      if (!live) { hideAll(); return; }
      const { shape, type, from, to, crit, effectiveness } = live;
      const p = clamp01(pRaw);
      const beat = beatAt(shape, p);
      const profile = profileFor(type);
      const colour = colourFor(type);
      const superEff = effectiveness > 1;
      // A crit's white flash lives entirely inside the impact beat, brightest at its start
      // and gone by its end — "one frame of a brighter flash", not a held tint.
      const flash = crit && beat.name === 'impact' ? (1 - beat.k) * 0.85 : 0;
      const strength = profile.intensity * (superEff ? 1.15 : 1);
      const impactBeat = beatOf(shape, 'impact');
      const deliverBeat = beatOf(shape, 'deliver');
      const resolveBeat = beatOf(shape, 'resolve');

      if (shape === 'projectile') {
        const headK = localK(deliverBeat, p);
        const opacity = p < impactBeat.to ? 1 : Math.max(0, 1 - localK(resolveBeat, p));
        beam.update({
          from, to, headK, trailFrac: 0.35, bow: 0, width: 0.22 * strength, opacity,
          flash, colorA: colour.core, colorB: colour.edge,
        });
        particles.update({
          from, to, phase: p, travelStart: 0, travelEnd: deliverBeat.to,
          motion: MOTION_CODE[profile.motion], role: ROLE_CODE[profile.role],
          strength, flash, colorA: colour.core, colorB: colour.edge,
        });
        // `ground` is set below, by the shared impact-shockwave block — not hidden here, since
        // every non-field shape reaches that block regardless of which branch ran first.
      } else if (shape === 'contact') {
        let opacity;
        // A square-root ramp front-loads brightness: the slash reads clearly early in the
        // swing instead of fading in so linearly it is only legible once the burst beside it
        // is already doing the work (found by screenshot: the arc alone, mid-deliver, was
        // nearly invisible against noon-bright grass at a linear ramp).
        if (p < deliverBeat.from) opacity = 0;
        else if (p < deliverBeat.to) opacity = Math.sqrt(localK(deliverBeat, p));
        else if (p < impactBeat.to) opacity = 1;
        else opacity = Math.max(0, 1 - localK(resolveBeat, p));
        beam.update({
          from, to, headK: 1, trailFrac: 1, bow: 0.7 * strength, width: 0.5 * strength,
          opacity, flash, colorA: colour.core, colorB: colour.edge,
        });
        particles.update({
          from: to, to, phase: p, travelStart: impactBeat.from, travelEnd: impactBeat.to,
          motion: MOTION_CODE[profile.motion], role: ROLE_CODE[profile.role],
          strength, flash, colorA: colour.core, colorB: colour.edge,
        });
      } else {
        // field: a rune grows under the target through delivery, holds through impact, fades.
        let radius;
        let opacity;
        if (p < deliverBeat.to) { radius = 1.15 * localK(deliverBeat, p); opacity = radius > 0.02 ? 1 : 0; }
        else if (p < impactBeat.to) { radius = 1.15; opacity = 1; }
        else { radius = 1.15; opacity = Math.max(0, 1 - localK(resolveBeat, p)); }
        ground.update({
          at: to, radius, thickness: 0.22, opacity, second: superEff ? 1 : 0,
          colorA: colour.core, colorB: colour.edge,
        });
        particles.update({
          from: to, to, phase: p, travelStart: deliverBeat.from, travelEnd: impactBeat.to,
          motion: MOTION_CODE[profile.motion], role: ROLE_CODE[profile.role],
          strength, flash, colorA: colour.core, colorB: colour.edge,
        });
        beam.hide();
      }

      // A small shockwave ring on impact for contact/projectile too, distinct from field's own
      // rune (which already covers the ring) — the plan's own "onda de choque" for every shape.
      if (shape !== 'field') {
        if (beat.name === 'impact') {
          ground.update({
            at: to, radius: 0.3 + beat.k * 0.95, thickness: 0.18, opacity: Math.max(0, 1 - beat.k),
            second: superEff ? 1 : 0, colorA: colour.core, colorB: colour.edge,
          });
        } else {
          ground.hide();
        }
      }
    },

    /** Everything off, and the record cleared. */
    hide() { live = null; hideAll(); },
    playing: () => !!live,

    dispose() { particles.dispose(); beam.dispose(); ground.dispose(); },
  };
}
