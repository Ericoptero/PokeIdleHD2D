/**
 * The palette and the light model, plus the handful of canvas paint primitives still standing
 * after Stage 9 retired the last DS-style panel (`plates.js`/`callout.js`/`floaters.js` — the
 * nameplates, speech balloons and damage numbers projected onto the 3-D world, and `index.js`'s
 * own debug overlay — are what remains on the canvas at all, by design: they are projected
 * against the orthographic camera every rendered frame with no depth divide, which is what
 * keeps a nameplate on the same pixel grid as the sprite it names, and a DOM element cannot be
 * positioned that precisely without reintroducing the sub-pixel drift this architecture exists
 * to avoid).
 *
 * The colours are the Black & White 2 building ramps, copied verbatim out of
 * `tools/structures/pixel.js` (`src/` may not import `tools/`, and the asset generator fixes those
 * ramps as the authored buildings' palette — the Pokemon Center roof on screen and this file's
 * own `C.roofBase` are the same red on purpose).
 *
 * **What used to live here and is gone**: the DS menu-box panel language
 * (`header`/`well`/`row`/`button`/`pokeball`/`itemMark`, `CURRENCY_COLOUR`, `TOAST_COLOUR`) —
 * every caller of any of it was a canvas panel, and Stage 9 converted the last six. `C`,
 * `panel`, `meter`, `hpRamp` and the light model (`applyLight`/`lightAt`/`litAt`) survive
 * because the world-projected overlays above still paint with them.
 */

export const C = {
  // Pokemon Center red
  roofDeep: '#6E1A1C', roofShadow: '#9E2B2C', roofBase: '#C93B38', roofLight: '#E05B4F', roofHi: '#F0857A',
  // Mart blue
  martDeep: '#123A5E', martShadow: '#1B5788', martBase: '#2A79B0', martLight: '#4A9BCE', martHi: '#7FC0E4',
  // stucco — the paper of every panel
  wallDeep: '#9A8A6E', wallShadow: '#C4B08C', wallBase: '#E6D6B4', wallLight: '#F5E9CE', wallHi: '#FFF8E6',
  // stone
  stoneDeep: '#4A4A46', stoneShadow: '#6B6B63', stoneBase: '#8C8C80', stoneLight: '#A8A89A', stoneHi: '#C4C4B6',
  // glass
  glassDeep: '#1D4E68', glassShadow: '#2E7392', glassBase: '#4E9BBE', glassLight: '#79C0DC', glassHi: '#B8E6F5',
  // lamp glow — the accent for anything the player just gained
  glowDeep: '#8A5A18', glowBase: '#E0A73C', glowLight: '#F6D488', glowHi: '#FFF0C4',
  woodDeep: '#5A3524', woodShadow: '#7E4A31', woodBase: '#A5673F', woodLight: '#C4854F', woodHi: '#DDA66C',
  white: '#FAF7EE', offWhite: '#E8E2D2', ink: '#241E1B', shadowInk: '#3A322C',
  ballRed: '#D6453C', ballWhite: '#F5F1E6', ballBand: '#2A2320',
  // the middle rung of the away card's efficiency ramp — here rather than inline so the
  // light model below reaches it like everything else
  bandMid: '#C2851F',
  // --- the recess ---------------------------------------------------------------------
  // The dark end of the range, and the answer to the round-1 fault that every panel
  // interior was one flat desaturated tan: measured, the shop/boxes/dex windows came out at
  // luminance mu 154-164 with saturation p50 28.6 and **no pixel below 62** — the whole
  // shadow end of the tonal range was simply absent, so a full-screen panel turned the
  // player's screen into a beige spreadsheet. A DS list does not sit on paper; it sits in a
  // dark recessed well with light type in it, and that is what these are for.
  deepDeep: '#141A2A', deepShade: '#1D2538', deepBase: '#2A3348', deepLight: '#3C4A66',
  deepInk: '#D6E0F2', deepDim: '#9AABCB', deepFaint: '#7C8CAE',
};

// ---------------------------------------------------------------------------------------
// The light
// ---------------------------------------------------------------------------------------

/**
 * **The HUD is lit by the same sky the city is.**
 *
 * Round 1 measured out at a hard constant: the wallet's paper was luma 233.6 at noon, 233.6
 * at 17:30 and 233.6 at 21:00, while the plaza under it went 133.9 -> 0.2 and the frame mean
 * went 105.7 -> 56.7. A chip at 233.6 over a surface at 0.2 is roughly 1000:1 of local
 * contrast, and it reads as a cream sticker pasted onto a night photograph rather than as
 * the game's own furniture. `hud.js` already had the signal — `onPhase(p) { phase = p; }` —
 * and used it only to pick a word.
 *
 * So every colour in this file is a *base* colour, and `applyLight(tod)` writes the lit
 * version back into `C` in place. Everything that reads `C.x` at paint time picks it up with
 * no further plumbing.
 *
 * Two constraints shape the curve, and the second is the one that stops this from being a
 * simple multiply:
 *
 *  - it has to be a **function of `tod` alone**, so the same URL still gives the same pixels
 *    (tools/shots/shoot.js). No wall clock, no live sun query.
 *  - it may not eat the panel's own legibility. Scaling paper *and* ink by 0.36 (which is
 *    what matching the ground would need) takes ink-on-paper from 13:1 to 2.4:1 — the panel
 *    would be lit and unreadable. The night factor is therefore 0.65 of luma, measured:
 *    paper #F5E9CE 233.6 -> 152, ink #241E1B against it 6.1:1, still past WCAG AA.
 */
const BASE_C = { ...C };

/**
 * The lamp ramp is **emissive** and is not dimmed by the sky.
 *
 * `glow*` is described at the top of this file as "the accent for anything the player just
 * gained" — it is lamplight, not paint, and a lamp does not go dim because the sun set. Two
 * things fall out of that, and the second is why it is a rule rather than a preference:
 * at night an undimmed amber over a dimmed panel reads as *lit*, which is what it is for;
 * and the ink-on-amber contrast the away card's efficiency bands depend on does not collapse
 * with the rest of the palette (multiplying both sides of a pair by 0.6 costs about half the
 * ratio once WCAG's 0.05 flare term stops being negligible — the worst band would fall from
 * 5.2:1 to 2.5:1).
 */
const EMISSIVE = new Set([
  'glowDeep', 'glowBase', 'glowLight', 'glowHi', 'bandMid',
  // The deep recess is a **screen**, not a surface. A dex list and a PC box are displays
  // inside the device the player is holding, and a display does not go dim because the sun
  // set — so the well and the type in it keep their own light while the panel around them
  // takes the sky's. That is also the only way the numbers survive: dimmed with everything
  // else, `deepDim` on `deepBase` falls from 5.4:1 at noon to 2.8:1 at 21:00, and the box
  // counts and the unseen dex rows stop being readable at exactly the hour an idle player
  // is most likely to be looking at them.
  'deepDeep', 'deepShade', 'deepBase', 'deepLight', 'deepInk', 'deepDim', 'deepFaint',
]);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Moonlight, low sun, and high sun — the three casts the scene itself has. */
const NIGHT_CAST = [0.594, 0.648, 0.846];
const GOLDEN_CAST = [0.990, 0.873, 0.718];
const DAY_CAST = [1, 1, 1];

/**
 * The per-channel multiplier for a time of day. `sin(pi*(tod-6)/12)` is a plain solar-elevation
 * proxy: 0 at 06:00 and 18:00, 1 at noon, negative at night — the same shape `environment`
 * drives the sun with, without reaching into it.
 */
export function lightAt(tod) {
  const t = ((Number(tod) || 0) % 24 + 24) % 24;
  const k = Math.sin(Math.PI * (t - 6) / 12);
  const warm = mix3(GOLDEN_CAST, DAY_CAST, smoothstep(0.05, 0.82, k));
  return mix3(NIGHT_CAST, warm, smoothstep(-0.12, 0.12, k));
}

function shade(hex, m) {
  const h = String(hex);
  if (h[0] !== '#' || h.length !== 7) return h;
  const v = parseInt(h.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((v >> 16) & 255) * m[0])));
  const g = Math.max(0, Math.min(255, Math.round(((v >> 8) & 255) * m[1])));
  const b = Math.max(0, Math.min(255, Math.round((v & 255) * m[2])));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

let lightKey = null;

/**
 * Re-lights the palette for `tod`. Quantised to the quarter hour so the tinted glyph
 * atlases `screen.js` caches per colour are rebuilt at most four times an hour rather than
 * once a frame; returns `true` when the palette actually moved, which is the caller's cue to
 * drop those caches.
 */
export function applyLight(tod) {
  const key = Math.round((((Number(tod) || 0) % 24 + 24) % 24) * 4) / 4;
  if (key === lightKey) return false;
  lightKey = key;
  const m = lightAt(key);
  for (const k of Object.keys(BASE_C)) C[k] = EMISSIVE.has(k) ? BASE_C[k] : shade(BASE_C[k], m);
  return true;
}

/** The quarter-hour the palette is currently lit for — the debug overlay reports it. */
export const litAt = () => lightKey;

/**
 * The frame every panel is drawn in.
 *
 * ```
 *   ..####..      the corner pixels are knocked out, which is what stops a hard-edged
 *   .######.      rectangle reading as a web div sitting on top of the game
 *   ########
 * ```
 *
 * @param {object} g   the painter from `screen.js`
 * @param {object} box `{ x, y, w, h }` in UI pixels
 * @param {object} [opts] `{ paper, edge, bevel, shade, drop }`
 */
export function panel(g, box, opts = {}) {
  const { x, y, w, h } = box;
  const paper = opts.paper ?? C.wallBase;
  const edge = opts.edge ?? C.ink;
  const bevel = opts.bevel ?? C.wallHi;
  const shade = opts.shade ?? C.wallDeep;

  // A one-pixel drop shadow to lift the panel off the scene without a blur.
  if (opts.drop !== false) {
    g.fill(x + 2, y + h, w - 2, 2, 'rgba(12,10,14,0.45)');
    g.fill(x + w, y + 2, 2, h - 2, 'rgba(12,10,14,0.45)');
  }

  g.fill(x + 1, y, w - 2, h, edge);
  g.fill(x, y + 1, w, h - 2, edge);
  g.fill(x + 1, y + 1, w - 2, h - 2, paper);

  // bevel: light on the top and left, dark on the bottom and right
  g.fill(x + 2, y + 1, w - 4, 1, bevel);
  g.fill(x + 1, y + 2, 1, h - 4, bevel);
  g.fill(x + 2, y + h - 2, w - 4, 1, shade);
  g.fill(x + w - 2, y + 2, 1, h - 4, shade);
  return box;
}

/**
 * The HP ramp — one colour pair per band, shared by the battle card, the party bar, the
 * trainer panel and the world's own nameplates (`plates.js`) so a Pokémon's bar reads the
 * same wherever it is drawn (all callers import the same ramp).
 *
 * The mainline goes green → yellow → red and **this palette has no green** (this file is a
 * deliberately warm, desaturated set). Rather than smuggle a foreign hue in for one widget,
 * the ramp runs mart blue → lamp amber → Center red: three steps at the same thresholds the
 * games use (1/2 and 1/5), so the *shape* of the cue survives even though the hue does not.
 */
export function hpRamp(frac) {
  if (frac <= 0.2) return { fill: C.roofBase, light: C.roofLight };
  if (frac <= 0.5) return { fill: C.glowBase, light: C.glowLight };
  return { fill: C.martBase, light: C.martLight };
}

/** A horizontal meter. `t` is 0..1. */
export function meter(g, box, t, { fill = C.glowBase, back = C.wallDeep, light = C.glowLight } = {}) {
  const { x, y, w, h } = box;
  g.fill(x, y, w, h, C.ink);
  g.fill(x + 1, y + 1, w - 2, h - 2, back);
  const n = Math.max(0, Math.min(w - 2, Math.round((w - 2) * Math.max(0, Math.min(1, t)))));
  if (n > 0) {
    g.fill(x + 1, y + 1, n, h - 2, fill);
    g.fill(x + 1, y + 1, n, 1, light);
  }
}

