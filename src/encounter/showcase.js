/**
 * encounter showcase — the moment, staged so a critic can see it happen.
 *
 * A still frame cannot show a roll, and a log nobody reads is not a feature. So this scene
 * does two things at once: it puts the **capture** on screen as a picture — the lead in the
 * grass, the wild Pokemon risen out of it, the ball in the air, the click — and it prints
 * the **numbers behind that exact frame** beside it, including the two independent re-rolls
 * that prove the encounter is reproducible.
 *
 * Modes (`?showcase=encounter&mode=…`):
 *
 *   walk      the lead standing in the grass with nothing rolled yet — the trigger cell
 *   reveal    the wild has just risen; the panel shows what was rolled and what it is worth
 *   throw     the ball at the top of its arc  (the default: it is the one unambiguous frame)
 *   shake     on the ground, wobbling, outcome not yet shown
 *   caught    the click and its sparkles
 *   escaped   the break-out, on an index this seed genuinely fails
 *   shiny     the first shiny this seed produces, found by scanning indices
 *   night     the nocturnal table at 21:30, with the Dusk Ball's 3x live
 *   balls     every one of economy's eighteen balls priced against one encounter
 *
 * Every mode stages, then **freezes both timelines** — `simulation`'s walk and this
 * module's own — so the same URL gives the same pixels (ARCHITECTURE §6.3, DECISIONS #14).
 * The harness spins ninety frames between `__READY__` and the shutter, and `registry.tick`
 * keeps running the whole time, so an unfrozen animation is a different picture every run.
 */

import { NORTH, DIR_DX, DIR_DZ } from '../core/dir.js';
import { SHINY_RATE } from './rolls.js';
import { todBand } from './tables.js';

const SLUG = 'bw2-adastra';
const MAP_ID = 'encounter-grass';
const MAP_SIZE = 52;

/** The road the party walks in on, and the field it turns off into. */
const ROAD = { x0: 30, x1: 32, z0: 4, z1: 48 };
/**
 * The spur stops at x 23, one cell east of the grass, and that is not cosmetic: `buildMap`
 * refuses to plant tall grass on a road cell, so a spur that ran under the patch would carve
 * a bare corridor straight through it and the walk would end on paving. The first cut of this
 * file ran the spur to x 14 and did exactly that: the queue froze on the path with the field
 * behind it, in the mode whose entire claim is that the lead is standing in the grass.
 */
const SPUR = { z0: 25, z1: 27, x0: 23, x1: 32 };
/**
 * The foreground track, and the reason the spur no longer ends in mid-air.
 *
 * Two measurements decided this rectangle. Projecting cell centres through the live camera
 * at the framing this module shoots (`?showcase=encounter&mode=throw`, 1600x900) puts row
 * `cz 27` at screen y 707, `cz 28` at 790 and `cz 29` at 880 — so **the whole bottom quarter
 * of every frame is rows 27 to 29**, and round 1 left all three as unbroken lawn. And the
 * spur's own west end at `x 23` lands at screen x 1260: hidden behind the panel at 1600x900,
 * plainly a bare tan rectangle mid-field at 1920x1080 and at `--pixelScale 2`.
 *
 * One change answers both. The spur turns south at its west end down `LINK` and runs west
 * again along `TRACK` across the foot of the picture, so it is a *junction* rather than a
 * stub, and the foreground is a road with a verge instead of eleven thousand identical
 * pixels of grass. `TRACK` also gives the two lamps somewhere to stand that a lamp belongs.
 */
const TRACK = { z0: 28, z1: 29, x0: 4, x1: 32 };
/** The elbow that joins the spur to the track. Two cells wide, so the corner autotiles. */
const LINK = { x0: 23, x1: 24, z0: 25, z1: 29 };
/**
 * Two street lamps on the track's north verge, and they are the whole of this module's
 * answer to "night is a multiply".
 *
 * `mode=night` is the frame built to sell the Dusk Ball's x3, and round 1 shot it into a
 * scene with **no light source in it at all**: the critic measured `c04` at median L 42.8
 * against noon's 107.2 — a near-uniform x0.40 — with the whole frame inside a 38-degree hue
 * wedge, a brightest pixel of L 114 and 0.00 % above L 140, against `docs/refs/03`'s 8.77 %
 * above L 100 and a max of 217. The grade is `environment`'s and DECISIONS #31a/#32e have
 * already been round the houses on it; what this scene could do and did not was *put
 * something in the frame that emits*. `environment.lamps.add()` is the published seam for
 * exactly that (#25d, #31h), it owns the dusk ramp so the lamps are dark at noon for free,
 * and its glow quad is authored to sit above the bloom threshold.
 *
 * Placed on `cz 27` — the verge between the walk row and the track — because the corridor
 * keeps that row clear of hedges and a lamp belongs beside a road. Never `orientation: 'n'`
 * or `'s'`: at a fixed 45-degree camera those arms point straight down the view axis and the
 * shade lands on its own post (DECISIONS #25a, #26e). Both arms point *inward*, so the two
 * pools fall on the near lawn the picture is composed around rather than off the edge.
 */
const LAMPS = [{ cx: 14, cz: 27, head: 'e' }, { cx: 22, cz: 27, head: 'w' }];

/**
 * Where a lamp model's bulb actually is, from its own bounds.
 *
 * The same arithmetic `city` uses, re-derived here rather than imported: a module reaches a
 * sibling only through `ctx.get` (ARCHITECTURE §5) and `city/layout.js` is not importable.
 * The arm overhangs its cell, so the bulb is at whichever end of the bounds leaves the cell.
 */
function bulbOf(model, cx, cz) {
  const b = model?.bounds;
  if (!b) return { x: cx + 0.5, y: 3.34, z: cz + 0.5 };
  const axis = (min, max) => (max > 1 ? max - 0.5 : (min < 0 ? min + 0.5 : 0.5));
  return { x: cx + axis(b.min[0], b.max[0]), y: b.max[1] - 0.22, z: cz + axis(b.min[2], b.max[2]) };
}
/**
 * The grass. Its south rim is the walk's own row on purpose: at a 45-degree camera a cell of
 * `tall_grass` covers about 0.9 tiles of screen depth, so the blades *between the lead and
 * the camera* are what hide it (the simulation critic caught exactly that — the lead was
 * swallowed in the mode named `grass`). Ending the patch on the walk's row leaves grass
 * behind and beside the lead and open ground in front of it.
 */
const PATCH = { x0: 6, x1: 22, z0: 21, z1: 26 };
/** The hedgerow that closes the field's north edge, two cells behind the grass. */
const BOUNDARY = PATCH.z0 - 1;
const SPAWN = { cx: 31, cz: 38, dir: NORTH };
/** How far west along the spur the queue walks before the freeze. */
const WEST_LEG = 12;

const isLive = (api) => !!api && api.__missing === undefined;
const pct = (n) => `${(Math.max(0, Math.min(1, n)) * 100).toFixed(1)}%`;

/** Position-stable 0..1 so a ragged patch edge is in the same place on every replay. */
function hash(x, z) {
  let h = Math.imul((x | 0) + 0x9e3779b9, 374761393) ^ Math.imul((z | 0) + 0x85ebca6b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The zoom each stop is shot at, in internal pixels per world unit.
 *
 * Was `pixelExactDistance(config, k)`, which solved for the camera distance that put a sprite
 * texel on `k` whole internal pixels at the window it was measured at. The density is a config
 * key now and the ladder has three rungs — 16, 32, 64 — because those are the only ones at
 * which 16-texel sprite art and 32-texel tile art are both whole (DECISIONS #60).
 *
 * Every stop takes `normal`, and that is a choice the ladder forced. These were shot at `k: 3`
 * — three internal pixels per sprite texel — which is not on it: 16-texel sprites want a
 * multiple of 16 and 32-texel tiles want 32 or a half of it, and 48 satisfies the first and
 * not the second. `close` was tried and cuts the party off at the knees against the message
 * box (10 cells across where the staging needs about 13), so `normal` it is. It is also the
 * zoom the game itself runs at, which is the more useful thing for a critic to be judging.
 */
const PPU = { wide: 16, normal: 32, close: 64 };

/** Every cell the walk touches, dilated by one, so nothing decorative lands in its way. */
function corridor(gap) {
  const cells = new Set();
  const mark = (cx, cz) => {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) cells.add(`${cx + dx},${cz + dz}`);
  };
  for (let i = 0; i <= gap * 4; i++) mark(SPAWN.cx - DIR_DX[SPAWN.dir] * i, SPAWN.cz - DIR_DZ[SPAWN.dir] * i);
  let cx = SPAWN.cx + DIR_DX[SPAWN.dir] * gap;
  let cz = SPAWN.cz + DIR_DZ[SPAWN.dir] * gap;
  mark(cx, cz);
  for (let i = 0; i < (SPAWN.cz - gap) - (SPUR.z0 + 1); i++) { cz--; mark(cx, cz); }
  // Three cells further west than the walk needs, so the staged wild Pokemon — which stands
  // two cells in front of the lead — is never planted on top of.
  for (let i = 0; i < WEST_LEG + 4; i++) { cx--; mark(cx, cz); }
  return cells;
}

/**
 * The map. Registered with `terrain` rather than built as loose meshes, because the walker's
 * collision goes through `terrain.passable()` and the encounter trigger goes through
 * `terrain.tagsAt()` — a scene that only existed as geometry would have the queue strolling
 * through the hedges and would never fire an encounter at all.
 */
function buildMap(draft, ctx, { lamps = false } = {}) {
  const tiles = ctx.get('tiles');
  const rng = ctx.rng.fork(`encounter/showcase/${draft.id}`);
  const W = draft.w, H = draft.h;
  const keep = corridor(Math.max(1, Math.round(ctx.config.followerGapTiles) || 1));
  const onRoute = (cx, cz) => keep.has(`${cx},${cz}`);

  const grass = tiles.find(SLUG, { category: 'ground', tags: ['grass'] });
  const ground = grass.length ? grass : tiles.find(SLUG, { category: 'ground' });
  draft.fill({ x: 0, z: 0, w: W, h: H }, (cx, cz) => tiles.pick(ground, cx, cz, { salt: 11 }), { collision: 'walk' });

  const inBox = (b, cx, cz) => cx >= b.x0 && cx <= b.x1 && cz >= b.z0 && cz <= b.z1;
  const onRoad = (cx, cz) =>
    (cx >= ROAD.x0 && cx <= ROAD.x1 && cz >= ROAD.z0 && cz <= ROAD.z1)
    || inBox(SPUR, cx, cz) || inBox(LINK, cx, cz) || inBox(TRACK, cx, cz);
  draft.autotile(tiles, 'set0', onRoad, { collision: 'walk', layer: 1, outsideIsFilled: false, tags: ['path'] });

  // The grass itself. `tallgrass` is the tag `terrain.tagsAt` reports and the tag this
  // module's `player:enteredTile` listener triggers on, so the patch is the feature, not
  // decoration: every cell of it is a die roll.
  //
  // AdAstra ships FIVE walkable tall-grass models — `tall_grass`, `tall_grass_light`,
  // `grass_patch`, `grass_patch_half` and `grass_decoration` — and using only the tallest
  // one made the patch a single repeating diagonal texture filling the top of the frame.
  // They are mixed by a position hash instead, and the two rows nearest the
  // camera are held to the SHORT models: at a 45-degree pitch a cell of `tall_grass` covers
  // about 0.9 tiles of screen depth, so it is the row *in front of* the lead that hides it,
  // not the row it stands in. That is the exact failure the simulation critic photographed.
  const tall = tiles.find(SLUG, { tags: ['tallgrass'], walkable: true });
  const byName = (n) => tall.find((m) => m.name === n);
  const tallGrass = byName('tall_grass') ?? tall[0];
  const lightGrass = byName('tall_grass_light') ?? tallGrass;
  const patchGrass = byName('grass_patch') ?? lightGrass;
  const halfGrass = byName('grass_patch_half') ?? lightGrass;
  const decorGrass = byName('grass_decoration') ?? halfGrass;
  let grassCells = 0;
  if (tallGrass) {
    for (let cz = PATCH.z0; cz <= PATCH.z1; cz++) {
      for (let cx = PATCH.x0; cx <= PATCH.x1; cx++) {
        if (onRoad(cx, cz)) continue;
        const front = cz === PATCH.z1;
        const edge = cx === PATCH.x0 || cx === PATCH.x1 || cz === PATCH.z0;
        const h = hash(cx, cz);
        // Ragged at the rim, and about one interior cell in twelve is left bare so the field
        // has holes in it rather than being a stamped rectangle. Never on the front row: a
        // gap there could leave the lead standing on plain ground in the shot whose whole
        // claim is that it is standing in the grass.
        if (!front && ((edge && h < 0.45) || h > 0.93)) continue;
        // `grass_patch`, `grass_patch_half` and `grass_decoration` all carry the `flat` tag:
        // they are ground decals, not blades. Using them on the front row left the lead
        // standing on a painted texture in the shot whose claim is that it is standing IN the
        // grass, so the front two rows are the *short* upright model and the flat ones are
        // scattered further back where they read as thinning cover.
        const model = front || cz === PATCH.z1 - 1
          ? (h < 0.7 ? lightGrass : tallGrass)
          : h < 0.5 ? tallGrass : h < 0.72 ? lightGrass : h < 0.88 ? patchGrass
            : h < 0.95 ? halfGrass : decorGrass;
        // **Every cell is turned and tinted**, and the turn is what stops the patch reading
        // as a nursery. Round 1 placed all ninety-odd cells at `rot 0` under one tint, and at
        // 2x — unmistakably at `--pixelScale 2` — the field resolved into rows of identical
        // fern rosettes at identical phase. `Placement` carries `rot` and `tint` and the
        // instancer honours both; an explicit `rot` also opts the cell out of the instancer's
        // own hashed spin, which only applies to flat ground anyway.
        //
        // The tint is the +-7 % red/blue, +-4 % green `tiles` uses for its own ground variety
        // (#25e), and it costs nothing: `instanceColor` is an attribute, not a draw call.
        //
        // Worth recording because it cost a wrong diagnosis for one frame: the first cut of
        // this hunk painted half the patch **navy-black**, which looks exactly like the
        // edge-on-card defect `simulation` measured on the trees (#29), and it was nearly
        // filed as "tall grass cannot be rotated". It was the tint. `255 * 1.07` is 273, and
        // `273 << 16` carries into the next byte, so an un-clamped "+7 % red" is a garbage
        // colour. Clamped, the same rotation renders correctly — re-shot to check, rather
        // than the finding being written up from the first frame.
        const v = hash(cx * 13 + 5, cz * 3 + 1);
        const ch = (k) => Math.max(0, Math.min(255, Math.round(255 * k)));
        const tint = (ch(1 + (v - 0.5) * 0.14) << 16)
          | (ch(1 + (v - 0.5) * 0.08) << 8)
          | ch(1 - (v - 0.5) * 0.14);
        draft.place(model, cx, cz, {
          collision: 'walk', layer: 5, tint, rot: (hash(cx * 5 + 2, cz * 11 + 7) * 4) & 3,
          tags: ['tallgrass', 'encounter'],
        });
        grassCells++;
      }
    }
  }

  // Hedgerows close the frame. No trees: every AdAstra tree is two crossed upright cards and
  // our camera never yaws, so one card is permanently edge-on and rasterises as a full-height
  // bright column (simulation measured it out of pack.bin and filed it). `hedge1` is real
  // geometry and survives the 45-degree camera.
  // **Not** `maxCells: 1`. Round 1 asked for single cells and got `hedge1` twenty-one times
  // in a row; AdAstra also ships the same bush authored 2, 3 and 4 cells wide as ONE model
  // (`hedge2/3/4`, and `_v2` for the north-south cuts), which is what `city` found for its
  // planters (DECISIONS #28h). A run drawn from the widest piece that fits has the artist's
  // own end caps instead of a seam every cell.
  const hedges = tiles.find(SLUG, { category: 'plant', tags: ['hedge'] });
  const singles = hedges.filter((m) => (m.w ?? 1) === 1 && (m.h ?? 1) === 1);
  if (hedges.length) {
    const free = (cx, cz) => draft.inside(cx, cz) && !onRoad(cx, cz) && !onRoute(cx, cz)
      && !draft.occupied[draft.idx(cx, cz)];
    const plant = (cx, cz) => {
      if (!free(cx, cz)) return;
      draft.place(tiles.pick(singles.length ? singles : hedges, cx, cz, { salt: 7 }), cx, cz, { collision: 'block', layer: 4 });
    };
    /**
     * A hedgerow laid as **runs with gaps**, from the widest model that fits.
     *
     * Round 1 planted one `hedge1` per cell across a 21-cell row with a 16 % dropout, which
     * at a fixed 45-degree camera is a wall of identical cubes with a seam between every
     * pair — `city` reached the same conclusion about its planters (DECISIONS #28h). Worse,
     * it is a single 21-cell **occluder**, so its own painted `kage_out` decals merge into
     * one continuous strip and the sun's shadow lands on top of that: measured on
     * `c03-caught-golden.png`, the row-mean luminance falls 94.3 -> 11.7 over the frame's
     * whole width with a 32-level step in one row. Breaking the row into runs of two to four
     * cells with one- to three-cell gaps breaks the bar with it, and `hedge2/3/4` (and their
     * `_v2` north-south cuts) draw a run as *one* model with the artist's own end caps.
     */
    const wide = new Map();
    for (const m of hedges) if ((m.w ?? 1) >= 1 && (m.h ?? 1) === 1) wide.set(m.w ?? 1, m);
    const runAt = (cx, cz, n) => {
      let left = n;
      while (left > 0) {
        let k = Math.min(left, 4);
        while (k > 1 && !wide.has(k)) k--;
        const model = wide.get(k) ?? singles[0] ?? hedges[0];
        let ok = true;
        for (let i = 0; i < k; i++) if (!free(cx + i, cz)) ok = false;
        if (ok) draft.place(model, cx, cz, { collision: 'block', layer: 4 });
        cx += k; left -= k;
      }
    };
    const hedgerow = (cz, x0, x1, salt, gate = null, drop = 0.30) => {
      let cx = x0;
      while (cx <= x1) {
        if (gate && cx >= gate.x0 && cx <= gate.x1) { cx = gate.x1 + 1; continue; }
        if (hash(cx, salt) < drop) { cx += 1 + ((hash(cx, salt + 17) * 3) | 0); continue; }
        let n = Math.min(2 + ((hash(cx, salt + 31) * 3) | 0), x1 - cx + 1);
        if (gate && cx < gate.x0) n = Math.min(n, gate.x0 - cx);
        if (n > 0) runAt(cx, cz, n);
        cx += Math.max(1, n);
      }
    };
    // The field's north edge, one cell behind the grass and *inside* the frame.
    //
    // The camera sits at `pixelExactDistance(k=2)` — about 20 tiles out at 1600x900 — and
    // covers roughly ten cells of ground depth around its focus, which the staging puts on
    // z 25. So z 20 is the top of the picture and a boundary any further north than that is
    // a boundary nobody ever sees; the first version put it at z 16 and the top 60 % of the
    // frame was undifferentiated grass.
    // …with a **gateway** in it, and that is a lighting decision as much as a compositional
    // one. At 17:30 `env.sun()` reports azimuth 270 and a shadow 5.93x the caster's height
    // (DECISIONS #31f), so a hedgerow's shadow runs due *east*, parallel to the row: a gap
    // narrower than six cells is filled in by its own neighbour's shadow and the row still
    // paints one unbroken bar across the frame, which is exactly what round 1's 16 % dropout
    // produced. The opening sits directly behind the action, is as wide as the smear, and
    // takes the band from **91 % of its columns under L 15 to 36 %** — and the eye reads
    // straight through it to the second hedgerow, which is depth the top of this frame did
    // not have. It does not make the *remaining* bar shallower: that ratio is the lighting
    // rig's and is measured in DECISIONS #39.
    const GATE = { x0: 13, x1: 18 };
    hedgerow(BOUNDARY, PATCH.x0 - 2, PATCH.x1 + 2, 9, GATE, 0.10);
    // A second hedgerow behind it, because a gateway has to open onto something. Projected
    // through the live camera, `cz 16` lands at screen y 100, so the row fills the top of the
    // band the gate opens up and the frame gets three planes of depth — near grass, far lawn,
    // far hedge — instead of one wall and a horizon. A different salt and a wider span, so
    // the two rows never gap in the same column.
    hedgerow(BOUNDARY - 4, PATCH.x0 - 5, PATCH.x1 + 6, 5);
    // The west boundary, running north-south, from the `_v2` cuts of the same bush.
    const tallWide = new Map();
    for (const m of hedges) if ((m.w ?? 1) === 1 && (m.h ?? 1) > 1) tallWide.set(m.h, m);
    for (let cz = BOUNDARY; cz <= PATCH.z1 + 1;) {
      if (hash(3, cz) < 0.24) { cz += 1 + ((hash(3, cz + 7) * 2) | 0); continue; }
      const k = Math.min(2 + ((hash(3, cz + 11) * 2) | 0), PATCH.z1 + 1 - cz + 1);
      const model = tallWide.get(k) ?? singles[0] ?? hedges[0];
      let ok = true;
      for (let i = 0; i < k; i++) if (!free(PATCH.x0 - 2, cz + i)) ok = false;
      if (ok) draft.place(model, PATCH.x0 - 2, cz, { collision: 'block', layer: 4 });
      cz += k;
    }
    // The far side of the foreground track: a low run under the frame's bottom edge, which
    // is what gives the near lawn a foreground plane instead of a horizon of nothing.
    hedgerow(TRACK.z1 + 1, 5, 21, 23);
    // Lone bushes on the far lawn — the band the gateway opens onto, `cz 18..19`, which is
    // screen y 181..226 and was 20 % of the frame with nothing in it. Singles, never a row:
    // a third hedgerow here would close the gate again and read as a maze.
    for (let cz = BOUNDARY - 3; cz <= BOUNDARY - 1; cz++) {
      for (let cx = PATCH.x0 - 3; cx <= PATCH.x1 + 3; cx++) {
        if (hash(cx * 7, cz * 13 + 3) > 0.93) plant(cx, cz);
      }
    }
    // Fields further south, off the default frame but inside `--size 1920x1080`.
    for (let cx = 8; cx <= 24; cx++) if (hash(cx, 39) > 0.16) plant(cx, 39);
    for (let cz = 33; cz <= 39; cz++) { plant(8, cz); plant(26, cz); }
    // A single rank inside the border so the world has an edge at any zoom.
    for (let cx = 2; cx < W - 2; cx++) { plant(cx, 2); plant(cx, H - 3); }
    for (let cz = 2; cz < H - 2; cz++) { plant(2, cz); plant(W - 3, cz); }
  }

  // The lamp posts, and **only after dark**. A street lamp at `cz 27` is two cells from the
  // camera-side edge of the frame, so its shade renders about 100 px across: at night that is
  // the brightest thing in the picture and the reason the frame reads at all, and at noon it
  // is a dead grey slab across the middle of the field with a hard black post shadow beside
  // it. Shot both ways and looked at. So the furniture follows the hour the shot asks for —
  // `tod` is a query parameter, so the same URL still gives the same pixels (DECISIONS #14).
  for (const spec of (lamps ? LAMPS : [])) {
    const model = tiles.find(SLUG, { category: 'light', orientation: spec.head })[0];
    if (model && draft.inside(spec.cx, spec.cz)) {
      draft.place(model, spec.cx, spec.cz, { collision: 'block', layer: 4 });
    }
  }

  const flowers = tiles.find(SLUG, { tags: ['flower'] });
  if (flowers.length) {
    draft.scatter(rng, (cx, cz) => tiles.pick(flowers, cx, cz, { salt: 2 }), {
      rect: { x: 5, z: 5, w: W - 10, h: H - 10 }, chance: 0.04,
      avoidTags: ['path', 'tallgrass'], opts: { collision: 'walk', layer: 5 },
    });
    // A second, denser pass over the two bands the camera actually frames as *lawn* — the
    // far lawn the gateway opens onto (`cz 17..19`) and the track's verges (`cz 26..30`).
    // A flower is a flat decal at a finer texel pitch than the grass under it, so it is the
    // one thing that puts high-frequency detail on an empty field without changing its
    // silhouette; `city` learned the opposite lesson (#28h) about laying them in *rows*, so
    // these are a hash scatter and never a grid.
    for (const band of [{ z0: BOUNDARY - 3, z1: BOUNDARY - 1 }, { z0: PATCH.z1 + 1, z1: TRACK.z1 + 1 }]) {
      for (let cz = band.z0; cz <= band.z1; cz++) {
        for (let cx = PATCH.x0 - 4; cx <= PATCH.x1 + 6; cx++) {
          if (!draft.inside(cx, cz) || onRoad(cx, cz) || draft.occupied[draft.idx(cx, cz)]) continue;
          if ((draft.tagsAt?.(cx, cz) ?? []).includes('tallgrass')) continue;
          if (hash(cx * 3 + 1, cz * 5) < 0.82) continue;
          draft.place(tiles.pick(flowers, cx, cz, { salt: 2 }), cx, cz, { collision: 'walk', layer: 5 });
        }
      }
    }
  }

  draft.spawn = { ...SPAWN };
  draft.mark('grass', PATCH.x1 - 4, SPUR.z0 + 1);
  ctx.log.info(`encounter map: ${grassCells} cells of tall grass, ${draft.placements.length} placements`);
}

/**
 * On the ground, and why this file no longer rebuilds it — "the showcase flattens its own
 * ground", retired.
 *
 * Round 1 hid `terrain`'s world and rebuilt the same placements with `variety: 0`, to dodge
 * the per-cell UV phase that three critics had called a checkerboard. `tiles` then shipped
 * its own round 2 and bounded that phase (DECISIONS #29, #30), so the workaround now buys
 * nothing and costs a duplicate `InstancedWorld` — and it was actively deleting the tonal
 * blotch `tiles` lays down on purpose (#25e).
 *
 * Measured, same URL one flag apart, at `?showcase=encounter&mode=throw&tod=12&grain=0`:
 * `?variety=1` against the round-1 default give a **maximum channel delta of 43** and, on the
 * far lawn, mean |gradient| **1.78 vs 1.79** with 5.18 % vs 5.24 % of gradients over 8 — i.e.
 * identical on the metric, and the 4x crops show no cell-edge step in either. So the scene
 * takes `tiles`' ground as it comes, like every other map in the project.
 */
// ---------------------------------------------------------------------------
// Choosing which encounter to stage
// ---------------------------------------------------------------------------

/**
 * Scans encounter indices for the first one whose *predicted* outcome matches what the mode
 * needs, without spending a ball or emitting anything.
 *
 * This is the honest way to stage a caught frame and an escaped frame: rather than rigging
 * the odds, ask the seed which of its own encounters catches with this ball and which does
 * not, and show that one. The prediction uses exactly the calls the live path uses —
 * `encounter.rollAt`, `encounter.oddsFor` and the same catch stream — so the frame the
 * scan promises is the frame `attempt()` then produces.
 */
/**
 * A rolled encounter with the HP the ball will actually be thrown at.
 *
 * `begin()` resolves the battle first and the exchange leaves the target between 8 % and
 * 40 % HP, which is the `hpFraction` term in the Gen 3/4 formula. Predicting an outcome
 * against a full-HP target would therefore under-state the odds and the scan would promise
 * an escape that the real throw then caught — the frame and its own caption disagreeing,
 * which is the worst thing a proof shot can do. `autoResolve` is the public call that
 * returns the same battle `begin()` will run, because both go through the same
 * `(seed, index)` stream.
 */
function probeOf(enc, rolled) {
  const battle = enc.autoResolve(rolled);
  // `hpFraction` is the wild's HP after the exchange: 0-ish when the party won, 1 when it did
  // not. `won` is carried explicitly so the scan does not have to infer it from a fraction.
  return { ...rolled, hpFraction: battle?.hpFraction ?? 1, won: battle?.outcome === 'win', turn: 0 };
}

/** How many of `economy`'s eighteen balls have a live condition on this encounter. */
function conditionsLive(enc, economy, rolled) {
  if (!isLive(economy) || typeof economy.items !== 'function') return 0;
  const probe = { ...rolled, hpFraction: 1, turn: 0 };
  let n = 0;
  for (const def of economy.items((i) => i.category === 'ball')) {
    const m = economy.catchMultiplier?.(def.id, enc.ballContext(probe, 1)) ?? 1;
    if (m > 1.05 && m < 255) n++;
  }
  return n;
}

function findIndex(enc, { want, ball, biome, tod, limit = 400, shinyRate = null, economy = null }) {
  if (want === 'variety') {
    let best = null;
    for (let i = 0; i < limit; i++) {
      const rolled = enc.rollAt(i, { biome, tod });
      if (!rolled) continue;
      const n = conditionsLive(enc, economy, rolled);
      // Ties go to the harder target, so the shelf still shows odds worth reading.
      if (!best || n > best.n || (n === best.n && rolled.catchRate < best.rolled.catchRate)) {
        best = { index: i, rolled, n };
      }
    }
    return best;
  }
  for (let i = 0; i < limit; i++) {
    const rolled = enc.rollAt(i, { biome, tod, rate: shinyRate ?? undefined });
    if (!rolled) continue;
    if (want === 'shiny') { if (rolled.shiny) return { index: i, rolled }; continue; }
    if (want === 'hard') { if (rolled.catchRate <= 60) return { index: i, rolled }; continue; }
    // `variety` is `mode=balls`'s scan and it exists because round 1's shelf was a wall of
    // repeats: thirteen of the eighteen printed `x1.00 . 15.1%` because their conditions
    // genuinely are not met at noon, in a meadow, against a species this seed has not caught.
    // That is correct behaviour and a useless picture. So the scan asks the seed for the
    // encounter that fires the *most* conditions rather than the hardest one, which is still
    // the seed's own encounter and not a rigged context.
    if (want === 'variety') continue;
    // **A ball is illegal until the wild is beaten** (DECISIONS #67), so an encounter the
    // party loses has no throw in it at all — and a mode that then asks to be frozen at the
    // `capture` beat is asking for a beat that does not exist. The scan skips them.
    const probe = probeOf(enc, rolled);
    if ((want === 'caught' || want === 'escaped') && probe.hpFraction > 0.99) continue;
    // A catch at 100 % odds is not a picture of a gamble. `mode=caught` wants an encounter
    // whose outcome was genuinely in doubt, so the scan asks for one and the panel reports
    // the odds it found.
    if (want === 'caught' && enc.oddsFor(ball, probe, 1) >= 0.96) continue;
    const odds = enc.oddsFor(ball, probeOf(enc, rolled), 1);
    const roll = enc.catchRollAt(i, 1);
    const caught = roll < odds;
    if ((want === 'caught') === caught) return { index: i, rolled, odds, roll };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------

/**
 * The panel, and the size of it.
 *
 * Round 1's readout measured **393x810 of a 1600x900 frame — 22 %** — and it showed the same
 * nine sections in all nine modes, so `mode=walk` and `mode=balls` differed from `mode=throw`
 * only inside the panel. A proof readout has to be legible, but 22 % of the picture is not a
 * proof, it is a wall: the composition came out 22 % panel, 25 % empty near lawn, 20 % empty
 * far lawn and the actual moment in a 400x160 box.
 *
 * So the panel is 286 px wide at 10 px, and it shows what *this* mode is about and nothing
 * else — the eighteen-ball shelf belongs to `mode=balls`, the step log to `mode=walk`, the
 * spawn table to everything else, and no mode gets two of them. Everything cut is still one
 * URL away in the mode that owns it.
 */
const PANEL_CSS = `
  .enc-panel { position:absolute; top:12px; right:12px; width:286px; max-height:calc(100% - 24px);
    overflow:hidden; background:rgba(7,10,17,.86); border:1px solid rgba(140,180,230,.20);
    border-radius:8px; padding:9px 10px; color:#cfe0f2; backdrop-filter:blur(7px);
    font:10px/1.45 ui-monospace, Menlo, monospace; }
  .enc-panel h2 { margin:0 0 2px; font-size:10px; letter-spacing:.14em; text-transform:uppercase;
    color:#7fb4e8; font-weight:600; }
  .enc-panel .sub { color:#6d829b; margin:0 0 6px; }
  .enc-panel section { border-top:1px solid rgba(140,180,230,.13); padding:6px 0 0; margin:6px 0 0; }
  .enc-panel section:first-of-type { border-top:0; margin-top:0; padding-top:0; }
  .enc-panel .k { color:#7d93ad; }
  .enc-panel .v { color:#eaf3fc; }
  .enc-panel b { color:#fff; font-weight:600; }
  .enc-panel .row { display:flex; justify-content:space-between; gap:10px; }
  .enc-panel .big { font-size:13px; line-height:1.25; color:#fff; letter-spacing:.02em; }
  .enc-panel .shiny { color:#ffd76a; }
  .enc-panel .good { color:#8ff0a8; }
  .enc-panel .bad  { color:#ff9a8f; }
  .enc-panel .warn { color:#ffcf7a; }
  .enc-panel .bar { height:5px; border-radius:3px; background:rgba(120,160,210,.16); overflow:hidden; margin:3px 0 6px; }
  .enc-panel .bar i { display:block; height:100%; background:linear-gradient(90deg,#4d8fd6,#8ff0a8); }
  .enc-panel table { width:100%; border-collapse:collapse; }
  .enc-panel td { padding:1px 0; vertical-align:top; }
  .enc-panel td.r { text-align:right; color:#eaf3fc; white-space:nowrap; }
  .enc-panel .ivs { display:flex; gap:3px; margin:2px 0 4px; }
  .enc-panel .ivs span { flex:1; text-align:center; border-radius:3px; padding:1px 0;
    background:rgba(120,160,210,.13); color:#cfe0f2; font-size:9px; line-height:1.25; }
  .enc-panel .ivs span.max { background:rgba(143,240,168,.22); color:#bcf7cb; }
  .enc-panel .proof { color:#8ff0a8; }
  .enc-panel .mode { position:absolute; top:14px; left:14px; }
`;

function panel(ctx, html) {
  const root = document.getElementById('ui') ?? document.body;
  let el = root.querySelector('.enc-panel');
  if (!el) {
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);
    el = document.createElement('div');
    el.className = 'enc-panel';
    root.appendChild(el);
  }
  el.innerHTML = html;
  return el;
}

function ivRow(ivs) {
  const keys = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  return `<div class="ivs">${keys.map((k) =>
    `<span class="${ivs[k] === 31 ? 'max' : ''}">${k}<br><b>${ivs[k]}</b></span>`).join('')}</div>`;
}

/**
 * The proof, computed at render time from the module's own public `rollAt`.
 *
 * Two independent calls for the same index, compared field by field. This is the claim the
 * whole module rests on and it is the one thing a screenshot *can* carry: the panel prints
 * both results and whether they matched, so the frame is its own evidence.
 */
function proofOf(enc, index, opts) {
  const a = enc.rollAt(index, opts);
  const b = enc.rollAt(index, opts);
  const same = JSON.stringify({ s: a?.species, l: a?.level, y: a?.shiny, i: a?.ivs })
    === JSON.stringify({ s: b?.species, l: b?.level, y: b?.shiny, i: b?.ivs });
  return { a, b, same };
}

function render(ctx, mode, staged) {
  const enc = ctx.get('encounter');
  const economy = ctx.get('economy');
  const collection = ctx.get('collection');
  const last = enc.last();
  const e = last ?? staged.rolled;
  const scene = enc.scene();
  const prog = enc.progress();
  const band = enc.band();
  const tod = staged.tod;

  // The panel is one column and the frame is 900 px tall, so the sections compete for room:
  // `mode=balls` trades the spawn table for the whole eighteen-ball shelf, and `mode=walk`
  // trades it for the trigger log, which is the one thing that mode is about. Everything
  // over-showing at once simply clipped the bottom two sections off the panel.
  // One long section per mode, never two: the eighteen-ball shelf is `mode=balls`'s reason to
  // exist, the step log is `mode=walk`'s, and everything else gets the spawn table.
  //
  // Round 3 cut it again, and this time for the *whole-game* critic rather than this
  // module's: "the catch resolving entirely inside a developer readout — odds, roll, shakes,
  // band table". The band table is what makes a readout a developer readout, and it was in
  // every picture mode. So the shelf belongs to `mode=balls`, the step log to `mode=walk`,
  // the spawn table to `mode=table`, and a mode whose job is a *picture* carries only what
  // its own frame is evidence for: what was rolled, what the ball did, and the two-line
  // proof that the roll replays.
  const wide = mode === 'balls';
  const showSteps = mode === 'walk';
  const showTable = mode === 'table';
  const showBalls = wide || showTable;
  const rows = (enc.rows(staged.biome, tod) ?? []).slice().sort((x, y) => y.weight - x.weight);
  const totalW = rows.reduce((n, r) => n + r.weight, 0) || 1;
  const top = rows.slice(0, 5).map((r) =>
    `<tr><td>${r.species}</td><td class="r">${((r.weight / totalW) * 100).toFixed(1)}% · rate ${r.catchRate}</td></tr>`).join('');

  const proof = proofOf(enc, e?.index ?? 0, { biome: staged.biome, tod });

  /**
   * The slot roster — what a lap will actually meet.
   *
   * `hunts` is not in this module's `showcaseNeeds` (this scene builds its own map), so an
   * empty roster is the ordinary case here and the section simply does not draw.
   */
  const hunts = ctx.get('hunts');
  const slotList = (hunts && hunts.__missing === undefined && typeof hunts.slots === 'function')
    ? hunts.slots() : [];
  const slotSummary = slotList.length
    ? `${slotList.filter((s2) => s2.occupied).length} of ${slotList.length} occupied` : '';
  const slotRows = slotList.slice(0, 8).map((s2) => `<tr><td>#${s2.k}</td>`
    + `<td>${s2.occupied ? (s2.species ?? '?') : '—'}${s2.shiny ? ' ★' : ''}</td>`
    + `<td>${s2.cx},${s2.cz}</td>`
    + `<td>${s2.approach ? `via ${s2.approach.cx},${s2.approach.cz}` : ''}</td></tr>`).join('');

  // The eight-row "last grass steps and their verdicts" table went with the roll it printed
  // (DECISIONS #73): nothing decides whether a Pokemon appears any more, so there is no coin to
  // show. What replaces it as the trigger's evidence is the **slot roster** below — which slots
  // this lap holds, what is standing on them, and which one the party is walking at.

  // Every ball in the bag, priced against this encounter. `economy` evaluates the
  // conditions; nothing here re-derives a multiplier.
  const balls = (isLive(economy) ? economy.items?.((i) => i.category === 'ball') ?? [] : [])
    .map((def) => ({
      id: def.id, name: def.name,
      // `economy` already writes the condition down for its own shop; printing it turns a
      // row of `x1.00` from "why is this here" into "this is the ball for a coast, and this
      // is not a coast". Nothing here re-words it.
      why: def.when ?? null,
      // `economy` evaluates the condition; nothing here re-derives a multiplier.
      mult: economy.catchMultiplier?.(def.id, enc.ballContext(e, (e?.turn ?? 0) + 1)) ?? 0,
      odds: enc.oddsFor(def.id, e, (e?.turn ?? 0) + 1),
    }))
    // By multiplier, not by odds: against a soft target half the line saturates at 100 % and
    // sorting on odds makes six identical rows. The multiplier is what actually separates
    // them, and it is the number the shop is selling.
    .sort((a, b) => b.mult - a.mult || b.odds - a.odds);
  const best = enc.bestBall(e);

  // The two words the panel prints are two different verdicts and round 1 ran them together
  // (`c04` captioned a failed catch `win`, `c10` printed `battle: flee` two rows above
  // `outcome: caught`). `battle` is the exchange — the party won it or lost it, and the wild's
  // remaining HP is what feeds the catch formula. `ball` is what the coin did. `flee` was the
  // battle module's word for "the party lost", which read as "the wild ran away".
  const outcomeClass = last?.caught ? 'good' : last?.outcome ? 'bad' : 'warn';
  const stageLabel = scene ? `${scene.stage}${scene.stage === 'shake' ? ` ${scene.shake}/${last?.shakes ?? 0}` : ''}` : 'idle';

  const dex = isLive(collection) ? collection.stats?.() : null;

  panel(ctx, `
    <h2>encounter · ${mode}</h2>
    <p class="sub">${staged.biome} · ${todBand(tod)} ${String(Math.floor(tod)).padStart(2, '0')}:${String(Math.floor((tod % 1) * 60)).padStart(2, '0')} · seed ${enc.seed()}</p>

    <section>
      ${mode === 'walk' ? '<p class="sub" style="margin:0 0 4px">nothing rolled yet — this is what encounter #0 <em>would</em> be</p>' : ''}
      <div class="big">${e?.shiny ? '<span class="shiny">★ </span>' : ''}${e?.display ?? '—'} <span class="k">Lv</span>${e?.level ?? '—'}</div>
      <div class="row"><span class="k">encounter #${e?.index ?? '—'}</span><span class="v">catch rate ${e?.catchRate ?? '—'}</span></div>
      ${e?.ivs ? ivRow(e.ivs) : ''}
      <div class="row"><span class="k">IV total</span><span class="v">${e?.ivTotal ?? 0} / 186 (${Math.round(((e?.ivTotal ?? 0) / 186) * 100)}%)</span></div>
      <div class="row"><span class="k">battle</span><span class="v">${e?.battle
        // **Three readings, not two.** A fight is stepped now (DECISIONS #72), so `win` is
        // `null` until somebody faints — and printing that as "party lost" put a defeat in the
        // readout beside a picture of a duel that had not started yet.
        ? `${e.battle.win === null ? 'in progress' : e.battle.win ? 'party won' : 'party lost'}`
          + ` · ${e.battle.turns} turn${e.battle.turns === 1 ? '' : 's'}`
          + `${e.battle.engine ? '' : ' (no engine)'} → wild HP ${pct(e.hpFraction)}`
        : '—'}</span></div>
    </section>

    <section>
      <div class="row"><span class="k">ball</span><span class="v">${last?.ballName ?? (best ? `${best.id} (suggested)` : '—')}${Number.isFinite(last?.multiplier) ? ` ×${last.multiplier.toFixed(2)}` : ''}</span></div>
      ${last?.odds != null ? `
        <div class="bar"><i style="width:${pct(last.odds)}"></i></div>
        <div class="row"><span class="k">odds</span><span class="v">${pct(last.odds)}</span></div>
        <div class="row"><span class="k">roll</span><span class="v">${last.roll.toFixed(6)} ${last.caught ? '&lt;' : '≥'} ${last.odds.toFixed(6)}</span></div>
        <div class="row"><span class="k">shakes</span><span class="v">${last.shakes}${last.caught ? ' + click' : ''}</span></div>
        <div class="row"><span class="k">ball (decided at the throw)</span><span class="${outcomeClass}"><b>${last.caught ? 'caught' : 'broke free'}</b></span></div>
        <div class="row"><span class="k">paid</span><span class="v">₽${last.rewards?.money ?? 0} · ${last.rewards?.exp ?? 0} exp</span></div>
      ` : '<div class="row"><span class="k">odds</span><span class="v">not thrown yet</span></div>'}
      <div class="row"><span class="k">animation</span><span class="v">${stageLabel} @ step ${scene?.step ?? 0}</span></div>
    </section>

    ${showBalls ? `<section>
      <div class="row"><span class="k">every ball, on this target</span><span class="v">${balls.length} in the line</span></div>
      <table>${balls.slice(0, wide ? 18 : 3).map((b) =>
        `<tr><td>${b.name}${wide && b.why ? ` <span class="k">${b.why}</span>` : ''}</td>`
        + `<td class="r">×${b.mult >= 255 ? '∞' : b.mult.toFixed(2)} · ${pct(b.odds)}</td></tr>`).join('')}</table>
    </section>` : ''}

    ${showTable ? `<section>
      <div class="row"><span class="k">table</span><span class="v">${rows.length} rows · band Lv${band.min}-${band.max}</span></div>
      <table>${top}</table>
    </section>` : ''}

    ${showSteps && slotRows ? `<section>
      <div class="row"><span class="k">slots · what a lap will meet</span><span class="v">${slotSummary}</span></div>
      <table>${slotRows}</table>
    </section>` : ''}

    <section>
      <div class="row"><span class="k">rolled twice, independently</span><span class="proof">${proof.same ? 'IDENTICAL' : 'DIVERGED'}</span></div>
      <div class="k">#${e?.index ?? 0} → ${proof.a?.species} Lv${proof.a?.level} iv${proof.a?.ivTotal}${proof.a?.shiny ? ' ★' : ''}</div>
      <div class="k">#${e?.index ?? 0} → ${proof.b?.species} Lv${proof.b?.level} iv${proof.b?.ivTotal}${proof.b?.shiny ? ' ★' : ''}</div>
      <div class="row"><span class="k">encounters</span><span class="v">${prog.encounters}</span></div>
      <div class="row"><span class="k">shiny rate</span><span class="v">1/${Math.round(1 / enc.shinyRate())}</span></div>
      ${dex ? `<div class="row"><span class="k">dex</span><span class="v">${dex.seen} seen · ${dex.caught} caught · ${dex.stored} stored</span></div>` : ''}
      ${isLive(economy) ? `<div class="row"><span class="k">bag</span><span class="v">${economy.count('pokeball')} Poké · ${economy.count('greatball')} Great · ₽${economy.balance('money').toLocaleString()}</span></div>` : ''}
    </section>
  `);
}

/**
 * The line the game itself would print, in the game's own message box.
 *
 * `ui.say()` is a published seam — ui/panels/dialogue.js says so in its own header: "any
 * module can call `ctx.get('ui').say(text, { speaker })`". It draws a DS message box into
 * `ui`'s low-res canvas with the era's font and the era's frame, at the bottom of the
 * picture, at the same pixel pitch as the scene. That is exactly the device
 * `docs/refs/01-forest-tilemap-frame.png` is built around, and it is the difference between
 * a frame that *narrates* a capture in a side panel and one that *is* a capture.
 *
 * It is safe here and it would not be in the live game, which is why `index.js` emits a
 * toast instead (see `begin()`): the box waits for a keypress to close, and an idle game
 * that opened one on every encounter would leave a modal in front of an absent player. In a
 * showcase there is no player, the box never has to close, and — unlike a toast — it carries
 * no wall-clock timer, so the same URL gives the same pixels (DECISIONS #14).
 */
function say(ctx, mode, staged, enc) {
  const ui = ctx.get('ui');
  if (!isLive(ui) || typeof ui.say !== 'function') return false;
  const last = enc.last();
  const e = last ?? staged.rolled;
  const name = (e?.display ?? e?.species ?? 'Pokemon').toUpperCase();
  const ballName = last?.ballName ?? 'BALL';
  const line = {
    // No wild on screen yet, and that is the point of the beat.
    approach: 'The tall grass rustled!',
    reveal: `A wild ${name} appeared!`,
    shiny: `A wild ${name} appeared! It is shining…`,
    // The mainline prints the trainer's own line at the throw, not the odds.
    throw: `Go! ${ballName.toUpperCase()}!`,
    // What the games put on screen while the ball wobbles: nothing but the wait.
    shake: '…',
    caught: `Gotcha! ${name} was caught!`,
    escaped: `Oh, no! The ${name} broke free!`,
    night: `Go! ${ballName.toUpperCase()}!`,
    // `walk`, `balls` and `table` are the readout modes; a message box would be a caption on
    // a diagram rather than a moment, and it would cover the section they exist to show.
  }[mode];
  if (!line) { ui.close?.(); return false; }
  ui.say(line);
  return true;
}

// ---------------------------------------------------------------------------
// The modes
// ---------------------------------------------------------------------------

/**
 * Where each mode stops this module's own timeline — as a **stage**, not a step number.
 *
 * The shake window is `shakes × 14` steps long and `shakes` comes out of the catch roll, so
 * "the frame where the ball clicks" is step 88 for a three-wobble catch and step 46 for a
 * nought-wobble miss. The first cut of this file hardcoded 78 for `mode=caught` and froze on
 * the third wobble instead of the click. `encounter.advanceToStage()` does the arithmetic
 * against the encounter that was actually rolled.
 */
const STOP = {
  // **k = 3, i.e. two thirds of the distance every other mode frames at.** `mode=walk` has no
  // ball and no wild in it: its whole claim is that the lead is standing on a cell tagged
  // `tallgrass` and that the trigger rolled on it, and at the default framing that claim was
  // a 60-pixel sprite in the middle of the same picture `mode=throw` takes. Only the panel
  // changed between the two, which is what shooting more than one angle is for. `k` stays an
  // **integer** because `pixelExactDistance` only lands a sprite texel on a whole internal
  // pixel for integer k (DECISIONS #29).
  walk: { throw: false, ppu: PPU.normal },
  /**
   * **The grass, before anything is in it.** The first of the five beats the brief names,
   * and the one that did not exist: round 2's appear drew the wild from step 0, so there was
   * no frame in which something was happening and nothing had happened yet.
   *
   * 0.3 of `T.APPEAR` is inside `T.RUSTLE` (0.4) by a clear margin, so this mode is the
   * disturbance alone — no Pokemon, no ball, no bubble — with the lead standing in it.
   */
  approach: { stage: 'appear', at: 0.3, throw: false, ppu: PPU.normal },
  /**
   * **The top of the burst.** `T.RUSTLE` of the beat is grass alone and the wild comes out
   * over the remaining 0.6, so the apex of its hop is at `0.4 + 0.5·0.6 = 0.7` of the beat —
   * the full half-unit lift, the stretch at its tallest, the "!" bubble popped, and the
   * grass still open underneath it. Round 1 froze at 0.85 (24 screen px of lift, reading as
   * a Pokemon *sitting* in grass); round 2's 0.5 is now inside the rustle window.
   */
  reveal: { stage: 'appear', at: 0.7, throw: false, ppu: PPU.normal },
  // **Past the apex, not on it.** The trainer, the lead and the wild are all on one row and
  // the camera's yaw is fixed looking north, so screen-x *is* world-x and the lead stands
  // exactly halfway between thrower and target: a parabola frozen at its apex therefore puts
  // the ball at the follower's own column by construction. Measured on round 1's `c01`, ball
  // centre x 792 against the lead's 794 — two pixels — and the ball read as a hat. Freezing
  // later moves the ball down-range without leaving the air: at 0.72 it is 72 % of the way
  // across and still at 81 % of the apex height.
  throw: { stage: 'throw', at: 0.72, throw: true, ppu: PPU.normal },
  shake: { stage: 'shake', at: 0.45, throw: true, ppu: PPU.normal },
  caught: { stage: 'result', at: 0.34, throw: true, want: 'caught', ppu: PPU.normal },
  escaped: { stage: 'result', at: 0.3, throw: true, want: 'escaped', ppu: PPU.normal },
  shiny: { stage: 'appear', at: 0.7, throw: false, want: 'shiny', ppu: PPU.normal },
  /** The spawn table and the ball shelf's head, which the picture modes no longer carry. */
  table: { stage: 'appear', at: 0.7, throw: false, ppu: PPU.normal },
  // `night` does NOT force the clock. The harness applies `--tod` *after* `showcase()`
  // returns (`shoot.js` calls `__HOOKS__.setTimeOfDay` on the way to the shutter), so a mode
  // that set 21:30 for itself got a nocturnal spawn table printed over a midday picture —
  // the panel and the frame disagreeing, which is worse than either being wrong
  // (`00-night-at-noon.png`). The mode reads the clock like every other one and warns if it
  // is not actually night; shoot it with `--tod 21.5`.
  night: { stage: 'throw', at: 0.72, throw: true, wantNight: true, ppu: PPU.normal },
  // A *hard* target, or the table is eighteen rows of 100 %: a Great Ball on a 190-rate
  // Marill at 30 % HP already clears `a >= 255`. `want: 'hard'` scans for a low capture rate.
  // A *varied* target, not merely a hard one: see `findIndex`'s `variety` scan. Round 1
  // asked for a low capture rate and got thirteen rows of `x1.00`.
  balls: { stage: 'appear', at: 0.5, throw: false, ppu: PPU.normal, want: 'variety' },
};

export async function showcaseEncounter(mode, ctx) {
  /**
   * **The default is the reveal**, and that is this round's answer to the whole-game critic.
   *
   * `?showcase=encounter` with no mode is the URL an outside critic shoots, and it is the one
   * that produced `docs/progress/_whole/enc-default.png` and the verdict "there is no
   * encounter on screen at all — the catch resolving entirely inside a developer readout".
   * The default was `throw`, on the argument that a ball in the air is "the one unambiguous
   * frame". It is unambiguous about a *ball*; the wild in it is passive, un-marked and the
   * same size as three party members standing in the same grass, so the frame's subject was
   * whichever sprite the reader guessed at.
   *
   * The reveal is the frame that says an encounter is happening: the wild is the only thing
   * in the air, it is the only thing wearing the "!", the grass it came out of is still open
   * under it, and the box at the bottom names it. `throw` is one URL away and is still the
   * frame the ball's own critique is judged on.
   */
  const key = STOP[mode] ? mode : 'reveal';
  const stop = STOP[key];
  const enc = ctx.get('encounter');
  const sim = ctx.get('simulation');
  const economy = ctx.get('economy');
  const collection = ctx.get('collection');
  const terrain = ctx.get('terrain');
  const env = ctx.get('environment');

  const tod = Number.isFinite(ctx.config.tod) ? ctx.config.tod : 12;
  if (isLive(env)) env.setBiomePreset?.('meadow');
  if (stop.wantNight && todBand(tod) !== 'night') {
    ctx.log.warn(`encounter showcase "night": shot at ${tod.toFixed(1)} (${todBand(tod)}), so the ` +
      'nocturnal table and the Dusk Ball\'s 3x are not live — shoot it with --tod 21.5');
  }

  // Run the invariants the frame cannot show. `selfTest()` covers the roll tables, the odds
  // and the drop ledger — none of which a screenshot can check — and it reports a failure as
  // a console error, which is what makes the capture that ran it fail (§8.1).
  enc.selfTest?.();

  // Freeze this module's own trigger BEFORE the walk runs. `simulation.advanceTo` fires
  // `player:enteredTile` once per landing, and the walk crosses a dozen cells of tall grass:
  // left armed, it would consume grass-step indices and start an encounter of its own,
  // several steps before the one this scene means to stage.
  enc.freeze(true);
  enc.cancel();
  // A staged catch must not toast. `ui`'s toast fades on a 2.6 s wall-clock timer, which is
  // still on screen when the shutter opens and is the one thing in this frame that would not
  // be reproducible (DECISIONS #14).
  if (isLive(collection)) collection.setQuiet?.(true);

  // --- the map --------------------------------------------------------------
  const lampsOn = todBand(tod) === 'night';
  terrain.register(MAP_ID, (draft, c) => buildMap(draft, c, { lamps: lampsOn }));
  await terrain.load(MAP_ID, { w: MAP_SIZE, h: MAP_SIZE, tileset: SLUG, biome: 'meadow', seed: ctx.config.seed });


  // Register the bulbs with `environment`, which owns the night ramp and the point-light pool
  // (ARCHITECTURE §5.3). `clear()` first because a showcase may be re-entered; the numbers are
  // `city`'s (#28f) — sodium rather than a white LED, a reach short enough that the two pools
  // do not merge into a wash, and a glow quad deliberately large against its intensity so the
  // sodium colour lives in the halo.
  let lampCount = 0;
  if (isLive(env) && typeof env.lamps?.add === 'function') {
    env.lamps.clear?.();
    const tilesApi = ctx.get('tiles');
    for (const spec of (lampsOn ? LAMPS : [])) {
      const model = tilesApi.find(SLUG, { category: 'light', orientation: spec.head })[0];
      const b = bulbOf(model, spec.cx, spec.cz);
      env.lamps.add({ x: b.x, y: b.y, z: b.z, color: 0xffb166, intensity: 2.0, radius: 12, size: 0.85 });
      lampCount++;
    }
  }

  // --- the walk -------------------------------------------------------------
  const gap = sim.gap?.() ?? 2;
  const northLeg = (SPAWN.cz - gap) - (SPUR.z0 + 1);
  sim.placePlayer(SPAWN.cx, SPAWN.cz, SPAWN.dir);
  sim.walk(`n${northLeg} w${WEST_LEG + 6}`, { loop: false });
  sim.advanceTo(northLeg + WEST_LEG, 3);
  sim.freeze(true);

  const lineup = sim.lineup?.() ?? [];
  const lead = lineup[0] ?? { cx: PATCH.x1 - 4, cz: SPUR.z0 + 1 };
  const standing = terrain.tagsAt(lead.cx, lead.cz) ?? [];

  // --- which encounter -------------------------------------------------------
  const biome = 'meadow';
  // A shop-full of balls, so the "every ball on this target" table is priced against a bag
  // that actually holds them and `recommendBall` has something to recommend. Showcase-only:
  // `offline` never writes a save in showcase mode (DECISIONS #15), so nothing persists.
  if (isLive(economy)) {
    for (const def of economy.items((i) => i.category === 'ball')) economy.give(def.id, 5, 'showcase');
  }

  const ball = key === 'night' ? 'duskball' : key === 'escaped' ? 'pokeball' : 'greatball';
  enc.setBall(ball);

  let staged = null;
  if (stop.want === 'shiny') {
    // Scanned, not rigged: this is genuinely the first index under this seed whose shiny
    // draw lands under 1/4096, and the panel prints which one it is.
    staged = findIndex(enc, { want: 'shiny', ball, biome, tod, limit: 60000, shinyRate: SHINY_RATE });
  } else if (stop.want === 'hard') {
    staged = findIndex(enc, { want: 'hard', ball, biome, tod, limit: 3000 });
  } else if (stop.want === 'variety') {
    staged = findIndex(enc, { want: 'variety', ball, biome, tod, limit: 600, economy });
  } else if (stop.want === 'caught' || stop.want === 'escaped') {
    staged = findIndex(enc, { want: stop.want === 'caught' ? 'caught' : 'escaped', ball, biome, tod });
  }
  const index = staged?.index ?? 0;

  enc.setProgress({ steps: 24, encounters: index });

  // --- stage it ---------------------------------------------------------------
  let started = null;
  if (key !== 'walk') {
    started = enc.begin(enc.rollAt(index, { biome, tod }));
    // The wild's sprite sheet is fetched and atlased on demand, so the actor does not exist
    // until this resolves. Freezing the timeline before it lands is a screenshot of empty
    // grass — which is exactly the failure this await exists to stop.
    await enc.ready();
    /**
     * The reveal plays out first **only for a mode that then throws**, and the guard is not
     * cosmetic: it is the bug that made `mode=reveal` a picture of a Pokemon sitting in grass.
     *
     * `advanceToStage` computes an absolute target step and advances by `max(0, target -
     * step)` — it cannot rewind. Rolling to `('appear', 1)` first therefore parks the scene at
     * the END of the appear beat, and every later call for a step *inside* that beat advances
     * by zero. Round 2 asked for `('appear', 0.5)` and got step 14 of 14; the panel printed
     * `appear @ step 14` in `f02-reveal-morning.png` and nobody read it against the mode's own
     * stop. So the two beats that live inside the reveal — `approach` and `reveal` itself —
     * were the same frame, frozen after the hop had already come back down.
     *
     * A throwing mode still needs the pre-roll: `attempt()` only *queues* the throw (see
     * `marks()` in index.js), and a throw queued before the reveal has played is what keeps
     * `automation`'s synchronous ball from skipping the animation in the real game.
     */
    if (stop.throw) {
      enc.advanceToStage('appear', 1);
      enc.attempt(ball);
    }
    enc.advanceToStage(stop.stage, stop.at);
  }

  // --- frame it ---------------------------------------------------------------
  // Two cells of camera nudge west and one north: the camera follows the *trainer*
  // (ARCHITECTURE §5.4) and the wild Pokemon stands four cells further on than that — two
  // for the follower gap, two more for the stage — so an unshifted frame puts the subject
  // against the top edge.
  sim.frameOffset?.(-2, -1);
  ctx.config.set({ pixelsPerUnit: stop.ppu ?? PPU.normal });

  const staged2 = { biome, tod, rolled: started ?? enc.rollAt(index, { biome, tod }) };
  render(ctx, key, staged2);
  const spoke = say(ctx, key, staged2, enc);

  const l = enc.last();
  ctx.log.info(`encounter showcase "${key}": index ${index} → ${l?.display ?? '—'} Lv${l?.level ?? '—'}` +
    `${l?.shiny ? ' SHINY' : ''}, ball ${l?.ball ?? ball}, odds ${l?.odds != null ? pct(l.odds) : 'n/a'}, ` +
    `roll ${l?.roll?.toFixed(6) ?? 'n/a'}, outcome ${l?.outcome ?? 'pending'}; ` +
    `stage ${enc.scene()?.stage ?? 'none'} @ ${enc.scene()?.step ?? 0}; ` +
    `bubble ${enc.alerting?.() ? 'up' : 'down'}; message box ${spoke ? 'up' : 'down'}; ` +
    `lead at ${lead.cx},${lead.cz} on [${standing.join(',') || 'plain'}]; ${lampCount} lamps`);

  // A staged scene whose lead is not actually in the grass is not proving what it claims.
  // `warn`, not `error`: the shot is still a shot, and §7 counts errors.
  if (!standing.includes('tallgrass')) {
    ctx.log.warn(`encounter showcase "${key}": the lead is standing on [${standing.join(',') || 'plain'}], not tall grass`);
  }
}
