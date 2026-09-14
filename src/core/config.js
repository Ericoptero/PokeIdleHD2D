// @ts-check
/**
 * Every tunable a critic might ask us to change lives here, not in a module constant
 * (src/core/config.js). Overridable per-session by query string and by localStorage, so a
 * screenshot can be requested at an exact time of day, seed and pixel scale.
 */

export const DEFAULTS = {
  seed: 1337,

  // --- render ---------------------------------------------------------------
  /**
   * **Internal pixels per world unit. This is the pixel grid, and it is the primitive.**
   *
   * Everything else about the camera is derived from it. It used to be the
   * other way round -- `unitsPerPixel` fell out of `fov` and `cameraDistance` and the internal
   * buffer height, so it changed with the size of the window: 26.0 px/unit at 1080p, 23.7 on a
   * 1512-wide MacBook, 17.4 at the gate's own 1280x720. Sprites are magnified by a whole
   * number of pixels per texel, so that swing rounded to 2 on one machine and 1 on the next
   * and the trainer came out 82% bigger on one screen than the other; tiles are authored at 32
   * texels per unit and were being minified by a different fraction on every screen, which is
   * NEAREST dropping a different set of texel rows as you walk.
   *
   * **16, 32 or 64, and nothing else.** Sprites carry 16 texels/unit (`pokemon/sprites.js`),
   * so `pixelsPerUnit / 16` has to be whole: 16, 32, 48, 64. Tiles carry 32, so
   * `pixelsPerUnit / 32` has to be whole or an exact half: 16, 32, 64. The intersection is the
   * ladder, and 48 is the one that looks reasonable and is not.
   *
   * At 32 a sprite texel is exactly 2x2 internal pixels and a 32-texel tile texture is 1:1.
   */
  pixelsPerUnit: 32,
  /**
   * Internal render resolution divisor -- how many output pixels one internal pixel becomes.
   *
   * **0 derives it from the viewport**, which is what makes a phone playable: at a pinned 3 a
   * 390 px window rendered the world into a 130 px buffer, about five pixels per tile. A
   * positive number pins it, for the harness and for an A/B.
   */
  pixelScale: 0,
  /**
   * What `pixelScale: 0` aims the internal buffer at. A bigger screen gets a bigger pixel
   * rather than a wider world, so the framing stays roughly constant across devices.
   *
   * 640 frames 20 tiles across at `pixelsPerUnit: 32`. 768 restores the ~24 the perspective
   * camera used to show, at the cost of a smaller pixel on screen. One number, one knob.
   */
  targetInternalWidth: 640,
  /** Cap the internal buffer so a huge window cannot blow the frame budget. */
  maxInternalWidth: 960,
  /** Camera pitch below horizontal, degrees. 45 is the BW / Gamma Emerald framing. */
  cameraPitch: 45,
  /**
   * How far back along the view ray the camera stands, in tiles.
   *
   * **Not a zoom.** The camera is orthographic, so this changes nothing about
   * the size of anything -- it only decides how much headroom there is between `near` and
   * `far` for tall geometry in front of the focus. Zoom is `pixelsPerUnit`.
   */
  cameraDistance: 30,
  /** Height above the focus the camera aims at, so the player sits low-centre. */
  cameraLookAhead: 1.6,
  cameraDamping: 0.12,
  shadowMapSize: 2048,
  shadowExtent: 56,
  shadowBias: -0.0006,
  shadowNormalBias: 0.035,
  /**
   * Land each sprite's anchor on a whole internal pixel.
   *
   * The *size* is no longer in question: under the orthographic camera a sprite texel is
   * `pixelsPerUnit / 16` internal pixels at every depth on every device, which is why that key
   * is restricted to the ladder it is. What is still per-sprite is where the quad falls on the
   * grid — a correctly sized quad starting half a pixel into one blends every texel boundary
   * with its neighbour. `?spriteSnap=0` restores the old behaviour for an A/B.
   */
  spriteSnap: true,
  /**
   * Pin the internal pixels per sprite texel. 0 takes it from the grid, which is
   * `pixelsPerUnit / 16` — 2 at the shipped 32, on every window size. Pin it to compare sizes.
   */
  spriteMagnification: 0,
  /**
   * Snap the camera to the internal pixel grid.
   *
   * Pinning a sprite to a whole pixel while the focus lerps continuously slides the *ground*
   * under it by a fraction of a pixel every frame, which is the same mush seen from the other
   * side. Under the orthographic camera this one snap grids the entire scene rather than only
   * the focus plane, because there is no depth divide to make other planes disagree with it.
   * Off restores the free lerp.
   */
  cameraSnap: true,
  /** Studio-only yaw override, degrees, orbited about the fixed pitch — the game and every showcase boot at 0. */
  cameraYaw: 0,

  // --- ui ---------------------------------------------------------------------
  /**
   * The HUD's own pixel scale — a second, independent knob from `pixelsPerUnit`/`pixelScale`
   * above, which size the *world*. `screen.js` divides the renderer's own internal buffer size
   * by this before sizing the UI canvas, so at `2` every panel, every glyph and every icon
   * covers twice the screen pixels for the same buffer pixel — readability for a bigger
   * monitor or a player who wants larger text — with no change to a tile or a sprite, because
   * the two canvases are separate layers (`screen.js`'s own top-of-file comment) and nothing
   * about the world's pixel grid is touched.
   *
   * **1 or 2, and nothing else** — not the `pixelsPerUnit` ladder, a different ladder for a
   * different surface. `screen.js` clamps anything else down to the nearer of the two.
   */
  uiScale: 1,

  // --- post -----------------------------------------------------------------
  /**
   * Whether the film grain re-rolls every frame.
   *
   * Off, and deliberately: grain is evaluated per internal pixel, so an animated phase means
   * a 3x3 block of output pixels changing on every frame over the whole screen — visible as
   * a constant shimmer even on a still picture. A fixed dither still breaks banding.
   * `?grainAnimate=1` restores the old behaviour.
   */
  grainAnimate: false,

  bloomStrength: 0.55,
  bloomThreshold: 0.72,
  bloomRadius: 0.62,
  exposure: 1.0,
  vignette: 0.28,
  grain: 0.018,
  saturation: 1.06,
  contrast: 1.04,
  /**
   * Width of the contrast operator's soft toe. Contrast pivots about 0.5, so anything below
   * `0.5 - 0.5/contrast` goes negative and a hard clamp deletes that channel outright — at
   * the golden hour that was 49.1% of a frame with blue at exactly 0, against the reference
   * still's 1.17%, which is what every critic has been calling "hue-killed". The toe is a
   * smooth maximum against zero, so shade keeps its channel ratios. 0 restores the clamp.
   */
  contrastToe: 0.055,

  // --- world ----------------------------------------------------------------
  /** Fictional latitude used to place the sun; keeps shadows physically plausible. */
  latitude: 36,
  /**
   * Two knobs that bend the *rendered* sun away from the real one, for a reason four blind
   * judges found independently: at 36N the noon sun sits at 60 degrees of
   * elevation on an azimuth of 180 — due south — and this camera looks north and never
   * yaws. So at midday the key is directly behind the viewer and every shadow hides behind
   * the object that casts it: `--envNoShadow 1` at tod 12 changes 0.07% of the frame. The
   * physics is right and the picture is flat, and every A/B we lost was lost on the same
   * sentence, that the other image "has one committed light direction".
   *
   * `sunAzimuthOffset` rotates the whole daily arc so the key rakes across the frame rather
   * than sitting behind the camera — our fictional world's north simply is not the camera's
   * north. `sunMaxElevation` soft-caps how high it climbs, so a midday shadow still has a
   * length worth drawing. Both are art direction, not astronomy, and the sun still rises in
   * the east, sets in the west, and swings its shadows the right way round the day.
   */
  sunAzimuthOffset: 38,
  sunMaxElevation: 46,
  tod: 10.5,
  /** Real seconds per in-game hour. 60 => a full day in 24 minutes. */
  secondsPerGameHour: 60,
  timeFrozen: false,

  // --- gameplay -------------------------------------------------------------
  walkSecondsPerTile: 0.25,

  /**
   * How many corners a hunt's circuit is bent to (src/hunts/index.js).
   *
   * A hunt is walked on a closed loop found on the map, and the guaranteed shape is a
   * rectangle — four corners, and it reads like one. Each extra pair comes from displacing a
   * straight run sideways, which cannot open the ring, so this is a *target* and not a
   * promise: terrain that has no room for a bend keeps the straight it had.
   *
   * 4 is the plain rectangle. Above about 20 a circuit starts to read as a maze rather than
   * as a trail, and each bend costs the lap a little of its length.
   *
   * A biome may override it (and `loopDepth`) with a `loop` field of its own; `?loopCorners=`
   * sweeps it without editing code.
   */
  loopCorners: 12,
  /** How far one bend may push a run sideways, in cells. */
  loopDepth: 3,

  /**
   * How close the walking head has to come to an occupied spawn slot to start a fight.
   *
   * **One, because the party now walks to it.** It was 2 for three phases, and the reasoning was
   * sound for what the game did then: a slot is authored at Chebyshev 2 from the circuit, so a
   * reach of one could never fire from a cell on the path, and 23 encounters over four laps all
   * came from tall grass with the proximity trigger silent throughout.
   *
   * What changed is the walk. The head leaves the circuit to make contact (`hunts` plans the
   * approach with `bfsPath`, `simulation.detour` walks it), so by the time it lands on the
   * approach cell the wild is exactly one step away — and a fight that begins because the
   * trainer's Pokemon *reached* the creature is what the brief asks for, rather than one that
   * begins because it came within shouting distance. At 2 the encounter would fire from the
   * path before the detour was ever taken, and the party would never leave the circuit at all.
   */
  slotEngageTiles: 1,

  /**
   * How far off the circuit an occupied slot still pulls the party toward it, in tiles
   * (Chebyshev) — the "notice and approach" radius, Tibia-style, distinct from
   * `slotEngageTiles`'s own "contact" one. `hunts/index.js`'s `player:enteredTile` trigger
   * scans every occupied slot's own LIVE position within this range, picks the nearest, and
   * paths to it with a real search (`core/path.js`'s `bfsPath`) around collision —
   * replacing the old fixed two-step detour, which only ever reacted to the one slot the
   * current lap happened to be walking past.
   */
  aggroTiles: 5,

  /**
   * How many fixed sim steps one **action** takes — one side's blow, its balloon, its effect.
   *
   * Replaces `turnSteps`: a turn used to be staged as one 24-step block for
   * *both* sides together, which is exactly the "attacks at the same time" the brief asks
   * against — one `battle:strike` fired for each side in the same tick, so their balloons and
   * their effects always landed on top of each other. Now each strike a turn produces gets its
   * own beat, drained one at a time in speed/priority order (`battle/engine.js`'s own draw
   * order — this file changes nothing about who acts first), so a turn where both sides act
   * takes `2 * actionSteps`. 18 steps is 0.9 s — long enough to read one balloon and let one
   * effect finish before the next starts (`T.STRIKE`, `encounter/index.js`, is always shorter
   * than this), short enough that an eight-turn fight is still under it running twice as many
   * beats. Counted in **sim steps and not seconds** because the screenshot harness freezes the
   * clock, and a beat measured in wall time cannot be stopped on an exact frame.
   */
  actionSteps: 18,
  /**
   * The opening purse, `FIELD_START_MONEY` in the brief.
   *
   * Enough for one complete hunt kit before any loot income. It is credited as **not earned**,
   * so it does not move `progress().totalEarned` — the number every money-priced shop gate is
   * unlocked against.
   */
  fieldStartMoney: 100000,
  /**
   * How long the duel pauses while a revival item is used, in seconds.
   *
   * **Presentation, not a rule.** It is multiplied by 20 into sim steps for the watched fight
   * and is exactly zero in a fold, because `idle` and `offline` have no wall clock — a revive
   * costs the item and nothing else, in both paths, which is what keeps a replayed fight the
   * same fight as the one that was watched. `?reviveSeconds=0` gives the
   * harness an instant one.
   */
  reviveSeconds: 5,

  /**
   * How long a won fight's manual throw window stays open before the wild leaves unattended,
   * in seconds — only while Auto-Catch is off (`src/encounter/index.js`'s `leaveSteps()`);
   * automation throws well inside the shorter default either way. Long enough to read the
   * capture tooltip's ball/odds and choose; `?manualThrowSeconds=0` gives the harness an
   * instant window for a deterministic capture.
   */
  manualThrowSeconds: 5,

  /**
   * How much of its maximum HP the party gets back for completing one lap of a hunt.
   *
   * Per LAP and not per second, because that is what survives being chunked: `offline` applies
   * a gap in one call and `idle` drains it in slices, and a heal counted in whole laps lands
   * identically either way. Without it one lost fight ends the session — the lead faints, the
   * next member steps up, and a wiped party walks its circuit forever meeting nothing.
   */
  lapHealFraction: 0.34,
  /**
   * Tiles between one walker in the conga line and the next.
   *
   * 2, not the Black & White 1, and the number is measured rather than preferred: a sprite
   * is 16 texels per world unit stretched by 1/cos(45°), so a 32 px frame is
   * an upright quad 2.83 units tall, which under a 45° pitch covers 2.83·sin(45°) = 2.0
   * tiles of ground depth on screen. At a gap of 1 the walker in front covers the one behind
   * it completely — and the one behind is the lead Pokémon, which is the thing the brief is
   * about. BW could use 1 because its
   * camera is nearly top-down; ours is not.
   */
  followerGapTiles: 2,
  offlineCapS: 12 * 3600,
  /** The floor of the offline efficiency curve — what an hour away is worth at the limit. */
  offlineEfficiency: 0.55,
  /** How long away is still worth full rate, before the decay starts. */
  offlineGraceS: 1800,
  /** Half-life of the decay from full rate down towards `offlineEfficiency`. */
  offlineHalfLifeS: 3600,
  /** Gaps shorter than this are not worth a catch-up pass. */
  offlineMinS: 60,
  /** Longer than this and the anchor is treated as broken, not as a real absence. */
  offlineMaxPlausibleS: 10 * 365 * 24 * 3600,
  /** How often an open tab re-stamps its anchor, so a force-kill cannot claim the hours it was open. */
  offlineHeartbeatMs: 60000,
  /** Save write debounce, and the ceiling that stops a busy session starving the write. */
  saveDebounceMs: 2000,
  saveMaxDebounceMs: 15000,
  idleHeartbeatMs: 1000,

  // --- diagnostics ----------------------------------------------------------
  debug: false,
  showcase: null,
  /**
   * Boot straight into a destination: `?scene=hunt-forest`. Null means "wherever the save
   * left off", which is how the harness reaches a hunt at `/` rather than only in a showcase.
   */
  scene: null,
  settleFrames: 30,
  /**
   * Quarantine a module on purpose: `?break=economy`.
   *
   * src/core/registry.js's load-bearing rule — one broken module costs a feature and never the game — was the
   * only claim in this document with no way to *photograph* it. Now there is one: the named
   * module is failed before `init` runs, its dependents block exactly as they would after a
   * real throw, and the rest of the game keeps its frame loop. Comma-separated for more than
   * one. Never set outside a diagnostic URL.
   */
  break: null,
};

/**
 * Per-session diagnostics. Read from the URL, never from storage and never written to it — a
 * persisted `break` would quarantine a module on every later boot of that browser from a URL
 * nobody typed, and `showcase`/`scene` would pin the game to one screen.
 */
const SESSION_ONLY = new Set(['break', 'showcase', 'scene']);

const NUMERIC = new Set(Object.entries(DEFAULTS).filter(([, v]) => typeof v === 'number').map(([k]) => k));
const BOOLEAN = new Set(Object.entries(DEFAULTS).filter(([, v]) => typeof v === 'boolean').map(([k]) => k));

function coerce(key, raw) {
  if (NUMERIC.has(key)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULTS[key];
  }
  if (BOOLEAN.has(key)) return raw === '' || raw === '1' || raw === 'true';
  return raw;
}

export function makeConfig(search = typeof location !== 'undefined' ? location.search : '') {
  const values = { ...DEFAULTS };

  try {
    const stored = JSON.parse(localStorage.getItem('pokeidle.config') ?? '{}');
    for (const [k, v] of Object.entries(stored)) if (k in DEFAULTS && !SESSION_ONLY.has(k)) values[k] = v;
  } catch { /* a corrupt config is not worth failing the boot over */ }

  const params = new URLSearchParams(search);
  for (const [k, v] of params) {
    if (k in DEFAULTS) values[k] = coerce(k, v);
    else if (k === 'showcase') values.showcase = v;
  }

  const listeners = new Set();
  const api = {
    get: (k) => values[k],
    all: () => ({ ...values }),
    /** Live-tune. Used by environment.tune() and by the debug overlay. */
    set(patch) {
      let changed = false;
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULTS)) continue;
        if (values[k] !== v) { values[k] = v; changed = true; }
      }
      if (changed) for (const fn of listeners) fn(api.all());
      return changed;
    },
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    persist() {
      const diff = {};
      for (const [k, v] of Object.entries(values)) {
        if (SESSION_ONLY.has(k)) continue;
        if (v !== DEFAULTS[k]) diff[k] = v;
      }
      try { localStorage.setItem('pokeidle.config', JSON.stringify(diff)); } catch { /* private mode */ }
    },
    reset() { Object.assign(values, DEFAULTS); try { localStorage.removeItem('pokeidle.config'); } catch {} },
  };

  // Read like a plain object too: config.pixelScale
  return new Proxy(api, {
    get: (t, p) => (p in t ? t[p] : values[p]),
    has: (t, p) => p in t || p in values,
  });
}
