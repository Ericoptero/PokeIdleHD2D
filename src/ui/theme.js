/**
 * The palette and the panel language.
 *
 * The colours are the Black & White 2 building ramps, copied verbatim out of
 * `tools/structures/pixel.js` (`src/` may not import `tools/`, and DECISIONS #3 fixes those
 * ramps as the authored buildings' palette — the Pokemon Center roof on screen and the
 * header of the shop panel are the same red on purpose).
 *
 * The panel shape is the DS menu box: a hard two-tone frame with the corner pixels knocked
 * out, a light bevel inside the top and left edges, a dark bevel inside the bottom and
 * right, and a flat paper fill. No radius, no gradient, no blur — every edge lands on the
 * pixel grid the scene is drawn on.
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

/** Currency accents, matched to `economy/currencies.js`'s own colours but pulled onto the ramp. */
export const CURRENCY_COLOUR = {
  money: C.glowLight, research: '#7FE6C4', bp: C.glassLight, shards: '#C6A8FF',
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
 * version back into `C`, `CURRENCY_COLOUR` and `TOAST_COLOUR` in place. Everything that
 * reads `C.x` at paint time — which is everything — picks it up with no further plumbing.
 *
 * Two constraints shape the curve, and the second is the one that stops this from being a
 * simple multiply:
 *
 *  - it has to be a **function of `tod` alone**, so the same URL still gives the same pixels
 *    (§6.3). No wall clock, no live sun query.
 *  - it may not eat the panel's own legibility. Scaling paper *and* ink by 0.36 (which is
 *    what matching the ground would need) takes ink-on-paper from 13:1 to 2.4:1 — the panel
 *    would be lit and unreadable. The night factor is therefore 0.65 of luma, measured:
 *    paper #F5E9CE 233.6 -> 152, ink #241E1B against it 6.1:1, still past WCAG AA.
 */
const BASE_C = { ...C };
const BASE_CURRENCY = { ...CURRENCY_COLOUR };

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
  for (const k of Object.keys(BASE_CURRENCY)) CURRENCY_COLOUR[k] = shade(BASE_CURRENCY[k], m);
  for (const k of Object.keys(BASE_TOAST)) {
    TOAST_COLOUR[k] = { ...BASE_TOAST[k], bar: shade(BASE_TOAST[k].bar, m), edge: shade(BASE_TOAST[k].edge, m) };
  }
  return true;
}

/** The quarter-hour the palette is currently lit for — the debug overlay reports it. */
export const litAt = () => lightKey;

/**
 * Toast kinds, so `kind` reads before the text does.
 *
 * Round 1 carried the kind on **hue alone** and the critic measured it: good #2F7D4F and
 * info #6B6B63 came out 1.3 apart in luminance, which to a deuteranope is the same grey bar.
 * Two channels now carry it. The rails are separated in *value* as well as hue — measured
 * CIE L\*: good 82.9, warn 61.5, bad 46.8, offline 35.6, info 24.3, so no two are closer than 11 L\* —
 * and each kind also has a **mark**, which is the channel that survives any colour vision at
 * all.
 */
export const TOAST_COLOUR = {
  good: { bar: '#8FE0A8', edge: '#1C4E31', mark: '✓' },
  warn: { bar: '#C9871F', edge: '#4A2F0C', mark: '!' },
  bad: { bar: C.roofBase, edge: C.roofDeep, mark: '✗' },
  offline: { bar: C.martShadow, edge: C.martDeep, mark: '▾' },
  info: { bar: '#3A3A36', edge: '#1B1B18', mark: '·' },
};

/** Captured before the first `applyLight`, exactly as `BASE_C` is. */
const BASE_TOAST = Object.fromEntries(Object.entries(TOAST_COLOUR).map(([k, v]) => [k, { ...v }]));

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

/** A coloured title bar across the top of a panel, sunk into its frame. */
export function header(g, box, text, opts = {}) {
  const bar = opts.bar ?? C.roofBase;
  const barEdge = opts.edge ?? C.roofDeep;
  const h = opts.h ?? 13;
  g.fill(box.x + 1, box.y + 1, box.w - 2, h, bar);
  g.fill(box.x + 1, box.y + 1, box.w - 2, 1, opts.light ?? C.roofLight);
  g.fill(box.x + 1, box.y + h, box.w - 2, 1, barEdge);
  g.fill(box.x + 1, box.y + h + 1, box.w - 2, 1, C.ink);
  if (text) g.text(box.x + 5, box.y + 3, text, opts.ink ?? C.white, { shadow: barEdge });
  return { x: box.x + 1, y: box.y + h + 2, w: box.w - 2, h: box.h - h - 3 };
}

/**
 * An inset well — the recess a list or a grid sits in.
 *
 * `dark: true` is the deep recess: the paper goes to `C.deepBase` and the caller draws light
 * type into it. Everything that opts in has to opt in *completely* — a label left on `C.ink`
 * inside a dark well is invisible — so `row()` and `list()` take the same flag and hand back
 * the right ink rather than making each panel guess.
 */
export function well(g, box, opts = {}) {
  const { x, y, w, h } = box;
  const dark = !!opts.dark;
  g.fill(x, y, w, h, opts.paper ?? (dark ? C.deepBase : C.wallShadow));
  g.fill(x, y, w, 1, opts.shade ?? (dark ? C.deepDeep : C.wallDeep));
  g.fill(x, y, 1, h, opts.shade ?? (dark ? C.deepDeep : C.wallDeep));
  g.fill(x, y + h - 1, w, 1, opts.bevel ?? (dark ? C.deepLight : C.wallLight));
  g.fill(x + w - 1, y, 1, h, opts.bevel ?? (dark ? C.deepLight : C.wallLight));
  return { x: x + 1, y: y + 1, w: w - 2, h: h - 2 };
}

/** A row in a list: flat when idle, a solid plate when selected. */
export function row(g, box, { selected = false, disabled = false, dark = false } = {}) {
  if (selected) {
    g.fill(box.x, box.y, box.w, box.h, C.martBase);
    g.fill(box.x, box.y, box.w, 1, C.martLight);
    g.fill(box.x, box.y + box.h - 1, box.w, 1, C.martDeep);
  } else if (disabled) {
    g.fill(box.x, box.y, box.w, box.h, dark ? C.deepShade : 'rgba(74,74,70,0.18)');
  }
  if (selected) return C.white;
  if (disabled) return dark ? C.deepFaint : C.stoneShadow;
  return dark ? C.deepInk : C.ink;
}

/**
 * A small pressable plate. Returns its text colour.
 *
 * `danger` is the destructive treatment — the Pokemon Center red, white ink. It exists so
 * that RELEASE, the only irreversible action in the module, cannot be drawn in the same
 * cream as CONTINUE (round-1 issue 12).
 */
export function button(g, box, { active = false, disabled = false, danger = false } = {}) {
  const base = disabled ? C.stoneBase : (danger ? C.roofBase : (active ? C.martBase : C.wallLight));
  const light = disabled ? C.stoneLight : (danger ? C.roofLight : (active ? C.martLight : C.wallHi));
  const dark = disabled ? C.stoneDeep : (danger ? C.roofDeep : (active ? C.martDeep : C.wallDeep));
  g.fill(box.x, box.y, box.w, box.h, C.ink);
  g.fill(box.x + 1, box.y + 1, box.w - 2, box.h - 2, base);
  g.fill(box.x + 1, box.y + 1, box.w - 2, 1, light);
  g.fill(box.x + 1, box.y + box.h - 2, box.w - 2, 1, dark);
  return (active || danger) ? C.white : (disabled ? C.stoneShadow : C.ink);
}

/**
 * The HP ramp, shared by the battle card and the party bar (moved here for slice 017 rather
 * than duplicated a second time — `panels/battle.js` was its only caller and now imports it
 * from here).
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

/** The Poké Ball mark, 7×7, used as a bullet and on the offline card. */
export function pokeball(g, x, y, { red = C.ballRed, white = C.ballWhite, band = C.ballBand } = {}) {
  const rows = [
    '.#####.',
    '#RRRRR#',
    '#RRRRR#',
    '#BBBBB#',
    '#WW#WW#',
    '#WWWWW#',
    '.#####.',
  ];
  const map = { '#': band, R: red, W: white, B: band };
  for (let j = 0; j < rows.length; j++) {
    for (let i = 0; i < rows[j].length; i++) {
      const c = map[rows[j][i]];
      if (c) g.fill(x + i, y + j, 1, 1, c);
    }
  }
}
