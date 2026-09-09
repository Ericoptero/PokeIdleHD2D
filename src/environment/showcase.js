/**
 * environment showcase — a light rig, not a level.
 *
 * The critic has to judge *light* here, so the stage is built out of the things light is
 * read on and nothing else, and every one of them is inside the camera's actual window
 * (at pitch 45°, fov 26° and distance 34 that is roughly x∈[14,42], z∈[10,35] around the
 * focus — anything outside it is invisible however good it looks in the map data):
 *
 *   · a cliff massif on each side, one tall and one low, so a sun anywhere in the sky has
 *     something to throw a shadow *from*. Their shadows sweep across the open middle as the
 *     hour changes, which is the whole point: direction and length are the subject.
 *   · a broad stone crossroads through the middle — the brightest albedo in the tileset
 *     next to the darkest, so key-to-fill and colour cast are directly comparable
 *   · a fence line along the road: thin, waist-high, the most legible shadow caster there
 *     is, and the exact prop docs/refs/03 uses to sell its night
 *   · trees for soft broken occlusion, flowers for a saturated accent the grade shows on
 *   · street lamps with real point lights and bloom-triggering bulbs, for the night pools
 *   · open ground behind everything so fog has depth to build over
 *
 * Modes: `default`; any environment preset name (`golden`, `night`, `noon`, …) sets that
 * hour; `weather:<name>` turns weather on; `biome:<name>` switches the palette.
 *
 * ── The enclosed stage ───────────────────────────────────────────────────────────────────
 * `biome:cave` and `biome:interior` get a **different stage**, and that is a fix rather than
 * a flourish. Both presets set `enclosed: 1`, which means the sun stops casting and the
 * practicals do the modelling (DECISIONS #43) — and until round 7 the mode changed the
 * *palette* while leaving the meadow underneath it, so `?showcase=environment&mode=biome:cave`
 * was a lawn, a road and a hedge under a cave grade. It measured **mean 146.07, p50 150,
 * belowL8 0.000** — brighter than the noon city, because the cave preset's key is 5.2 and it
 * was landing on 56×48 cells of open grass with nothing over them. A showcase whose job is to
 * let a critic judge light cannot show the wrong room.
 */

import { PRESETS } from './presets.js';

const SLUG = 'bw2-adastra';

/** The tileset with rock in it. `bw2-adastra` has no cave art at all. */
const CAVE_SLUG = 'bw2-cave';

/**
 * Which biome presets have no sky, and therefore need the enclosed stage.
 *
 * Read off `presets.js`'s own `enclosed` field rather than listed by name here, so a preset
 * that gains or loses a roof cannot leave this file lying about which stage it needs.
 */
function isEnclosedBiome(name) {
  const keys = PRESETS[name];
  return Array.isArray(keys) && keys.some((k) => (k.enclosed ?? 0) >= 0.5);
}

/** Bulb height above the lamp's cell when the model carries no bounds. `lamp_h.obj` runs
 *  y 0.125 → 3.5625; the head is the top ~0.4 of that, so the emitter sits just under the tip. */
const LAMP_BULB_Y = 3.3;

/** Centre of the north–south road, in cells. Lamps west of it reach east, and vice versa. */
const ROAD_CX = 27;

/**
 * Where a lamp's bulb actually hangs, read off the model's own bounds.
 *
 * A 1x1 lamp whose arm reaches into the next cell has bounds that run past 1 (or below 0) on
 * exactly one horizontal axis, and the bulb sits half a cell inside that overhang. Deriving it
 * is what puts the pool under the *lantern* instead of under the post — the same arithmetic
 * `city` uses, reimplemented here rather than imported, because a showcase must not make
 * `environment` depend on `city`.
 */
function bulbOf(model, cx, cz) {
  const b = model?.bounds;
  if (!b) return { x: cx + 0.5, y: LAMP_BULB_Y, z: cz + 0.5 };
  const axis = (min, max) => (max > 1 ? max - 0.5 : (min < 0 ? min + 0.5 : 0.5));
  return { x: cx + axis(b.min[0], b.max[0]), y: b.max[1] - 0.22, z: cz + axis(b.min[2], b.max[2]) };
}

/** `tall_mountain_*` is 5 units tall, `mountain_*` is 1. Measured from the exported OBJs. */
const TALL_CLIFF_Y = 5;

/**
 * A room in the rock, for the two presets that have no sky.
 *
 * Same camera as the open stage — `rig.frame(27.5, 23, 0, 34)` — so a critic can put the two
 * side by side and the only difference is the light. What is in it, and why each thing:
 *
 *   · **rock over everything the floor does not claim.** `set3 cave_dark_border` is the top
 *     of that rock seen from above, laid first at layer 0 so the chamber's own wall tiles
 *     (`set0`, whose border slots rise through y 0..1) draw over it rather than under it.
 *     This is what stops the sky from showing: DECISIONS #11 paints the dome first with no
 *     depth test, so a hole in the map is a hole to the sky whatever the preset says.
 *   · **two islands of rock inside the chamber.** A room whose floor is one unbroken sheet
 *     reads as a warehouse; a metre of wall in the middle of it has a lit face and a shaded
 *     face, which is the whole thing being judged.
 *   · **a terrace**, a second floor a metre up in the north-east, so the frame has two levels
 *     with a wall between them — `docs/refs/04` is almost entirely one bank of rock stepping
 *     up behind another.
 *   · **`cave_big_rock`**, the 6×6 formation that runs y 2.03 → 6.48: the only piece in the
 *     set tall enough to model a key against, and the one thing in frame a lamp can rim.
 *   · **`cave_exit`** on the north wall, the one place daylight gets in.
 *   · **five practicals**, sized against `lamps.js`'s own clamps the way `hunts` measured
 *     them: the `PointLight` reach is clamped to 3.9 units and the painted pool to
 *     `min(4.2, radius * 0.42)` at `min(1, 0.205 * intensity + 0.035)` strength, so
 *     `radius 11, intensity 5` is one full-strength pool and anything dimmer is a smudge.
 *     Two are cold (the mouth), three are warm, because a room lit in one hue is the defect
 *     DECISIONS #46(b) measured and not a cave.
 *
 * `estalactita` is deliberately **not** placed, for the reason `hunts/biomes/cave.js`
 * measured: it hangs from y 3.26 to 8.24 expecting a ceiling this camera cannot have, and
 * every one of its faces points down, so after `tiles` clamps normals to the horizon it takes
 * no key and reads as a black triangle standing on the wall.
 */
async function buildEnclosedStage(ctx, tiles, env) {
  await tiles.load(CAVE_SLUG);
  const { MapDraft } = ctx.get('terrain');
  const W = 56, H = 48;
  const draft = new MapDraft({ id: 'showcase-env-cave', w: W, h: H, tileset: CAVE_SLUG, biome: 'cave' });

  const find = (q) => tiles.find(CAVE_SLUG, q);
  const byName = (n) => find({ category: 'cave' }).find((m) => m.name === n) ?? null;
  const rockTop = byName('cave_rock_ground_center') ?? byName('cave_ground_center');
  const bigRock = find({ category: 'cave', tags: ['tall'] }).find((m) => (m.w ?? 1) >= 5) ?? null;
  const exit = find({ category: 'cave', tags: ['cliff', 'tall'] }).find((m) => m.w === 2 && m.h === 3) ?? null;
  const mud = find({ category: 'cave', tags: ['floor', 'multicell'] });

  const ell = (cx, cz, x, z, rx, rz) => {
    const dx = (cx + 0.5 - x) / rx, dz = (cz + 0.5 - z) / rz;
    return dx * dx + dz * dz < 1;
  };

  // The chamber fills the camera's window with a margin of rock on every side, plus a bay to
  // the north-west so the room has somewhere to recede into rather than ending at a wall.
  const terrace = (cx, cz) => ell(cx, cz, 37, 16, 7.5, 5);
  const island = (cx, cz) => ell(cx, cz, 21.5, 21, 2.4, 1.8) || ell(cx, cz, 32, 28, 2.2, 1.6);
  const hollow = (cx, cz) => ell(cx, cz, 27, 25, 12, 8.5) || ell(cx, cz, 18, 16, 5.5, 4)
    || (cx >= 18 && cx <= 25 && cz >= 15 && cz <= 23);
  const floorAt = (cx, cz) => hollow(cx, cz) && !island(cx, cz) && !terrace(cx, cz);

  /**
   * The rock goes down first, over the whole map and a metre up, and the chamber is *cut into
   * it*. Round 7's first cut drew the outside with `set3 cave_dark_border` at y 0 instead, and
   * two things went wrong at once, both visible in the shot: `set3`'s centre slot is
   * `cave_dark_border_inner_ne` — the pack has nine dark-border models and an inner corner
   * doing duty as the fill — so a large solid region of it tiles as a lavender chequerboard;
   * and at y 0 the islands were level with the floor around them, so they read as pits rather
   * than as outcrops. A flat rock sheet one unit up has neither problem, and it is also what
   * the rock physically *is*: the top of the metre of wall the `set0` border slots climb.
   */
  if (rockTop) {
    draft.fill({ x: 0, z: 0, w: W, h: H }, (cx, cz) => (floorAt(cx, cz) ? null : rockTop),
      { y: 1, collision: 'block', layer: 0, tint: 0x9c8f86 });
  }
  draft.autotile(tiles, 'set0', floorAt,
    { y: 0, collision: 'walk', layer: 1, outsideIsFilled: false });

  // A floor with two materials reads as a place rather than as a fill.
  if (mud.length) {
    for (const [cx, cz] of [[24, 29], [30, 23], [22, 33]]) {
      draft.place(mud[(cx + cz) % mud.length], cx, cz, { y: 0, collision: 'walk', layer: 2, claim: false });
    }
  }
  // Stands *on* the rock behind the chamber, so its silhouette is read against the far wall.
  if (bigRock) draft.place(bigRock, 20, 7, { y: 1, collision: 'block', layer: 3, claim: false });
  // Straddles the chamber's north wall, which is the only place a mouth can be.
  if (exit) draft.place(exit, 26, 14, { y: 1, collision: 'block', layer: 3, claim: false });

  draft.finalize();
  tiles.buildInstances(ctx.three.scene, CAVE_SLUG, draft.placements, { name: 'showcase:env-cave' });

  env.lamps.clear();
  const bulbs = [
    { x: 31.5, z: 15.5, y: 3.0, color: 0xbfd8ff, intensity: 5.0, radius: 11, size: 0.02 },
    { x: 31.5, z: 18.5, y: 2.1, color: 0xa8c6f0, intensity: 3.2, radius: 10, size: 0.02 },
    { x: 23.5, z: 26.5, y: 1.9, color: 0xff9a4a, intensity: 5.0, radius: 11, size: 0.34 },
    { x: 33.5, z: 29.5, y: 1.8, color: 0xffb060, intensity: 4.4, radius: 10, size: 0.34 },
    { x: 18.5, z: 19.5, y: 1.7, color: 0xff8c3a, intensity: 4.0, radius: 10, size: 0.30 },
  ];
  for (const b of bulbs) env.lamps.add(b);

  ctx.three.rig.frame(27.5, 23, 0, 34);
}

export async function showcaseEnvironment(mode, ctx) {
  const tiles = ctx.get('tiles');
  const env = ctx.get('environment');

  // The enclosed presets need their own room, and they need it built *instead of* the open
  // stage rather than on top of it — see the note at the head of this file.
  const [modeName, modeArg] = String(mode ?? 'default').split(':');
  if (modeName === 'biome' && isEnclosedBiome(modeArg)) {
    env.setBiomePreset(modeArg);
    await buildEnclosedStage(ctx, tiles, env);
    return;
  }

  await tiles.load(SLUG);

  const { MapDraft } = ctx.get('terrain');
  const W = 56, H = 48;
  const draft = new MapDraft({ id: 'showcase-env', w: W, h: H, tileset: SLUG, biome: 'meadow' });
  const rng = ctx.rng.fork('environment:showcase');

  const first = (q) => tiles.find(SLUG, q)[0] ?? null;
  const grass = first({ category: 'ground', tags: ['grass'] }) ?? first({ category: 'ground' });

  // --- ground ---------------------------------------------------------------
  draft.fill({ x: 0, z: 0, w: W, h: H }, grass, { collision: 'walk' });

  // --- the road. Narrow on purpose: the stone albedo is the brightest thing in the
  // tileset, and a wide one takes over the histogram and flattens the whole frame. -----
  const road = (cx, cz) => (cx >= 25 && cx <= 29 && cz >= 6)
                        || (cz >= 27 && cz <= 30 && cx >= 20 && cx <= 40);
  draft.autotile(tiles, 'set0', road,
    { collision: 'walk', layer: 1, outsideIsFilled: false });

  // --- cliffs ---------------------------------------------------------------
  // West: `tall_mountain` (set6) is a full 5 units. At 17.30 the sun is 9.6 degrees up in
  // the west and a 5-unit wall throws its shadow **29.6 units** east — so the massif is
  // deliberately confined to the *northern* half of the stage (cz 6..17). The round-1 block
  // ran to cz 23 and its shadow then covered every open cell the camera could see: measured
  // with the shadow map toggled off, 47% of the frame changed, and a shadow that covers
  // everything reads exactly like no shadow at all. Half the stage is lit at every hour now,
  // so the other half's shadow has an edge to be read against.
  const westMass = (cx, cz) => cx >= 11 && cx <= 19 && cz >= 6 && cz <= 17;
  draft.autotile(tiles, 'set6', westMass,
    { collision: 'block', layer: 2, outsideIsFilled: false });
  // Grass on the plateau, a hair above the cliff's own top so the two never z-fight.
  // (see the note on the east shelf below for why the lid is needed at all)
  for (let cz = 7; cz <= 16; cz++) {
    for (let cx = 12; cx <= 18; cx++) {
      draft.place(grass, cx, cz, { y: TALL_CLIFF_Y + 0.02, layer: 2, collision: 'block' });
    }
  }

  // East: a one-unit shelf. Low sun in the morning rakes along it and throws west.
  draft.autotile(tiles, 'set3',
    (cx, cz) => cx >= 34 && cx <= 44 && cz >= 10 && cz <= 19,
    { collision: 'block', layer: 2, outsideIsFilled: false });
  // Both cliff sets fill their blob's centre slot with `stone_path_center`, a *flat* tile at
  // y=0 — so an autotiled massif is a walled tray, not a mesa. Lidding the interior with
  // grass at the wall height is what turns it into ground you could stand on.
  for (let cz = 11; cz <= 18; cz++) {
    for (let cx = 35; cx <= 43; cx++) {
      draft.place(grass, cx, cz, { y: 1.02, layer: 2, collision: 'block' });
    }
  }
  // A free-standing block out in the open, west of the road and *south* of the massif's
  // shadow band, so at 17.30 its own 6-unit shadow crosses the lit road with light on both
  // sides of it — the one read in the stage that is unambiguously "the sun is low and over
  // there". At 08.00 the same block throws west across open grass.
  draft.autotile(tiles, 'set3',
    (cx, cz) => cx >= 20 && cx <= 22 && cz >= 20 && cz <= 22,
    { collision: 'block', layer: 2, outsideIsFilled: false });

  // --- a fence along the road ----------------------------------------------
  draft.autotile(tiles, 'set9',
    (cx, cz) => (cx === 24 && cz >= 12 && cz <= 25)
             || (cx === 30 && cz >= 12 && cz <= 25)
             || (cz === 25 && cx >= 30 && cx <= 38),
    { collision: 'block', layer: 3, outsideIsFilled: false });

  // --- trees: soft, broken occlusion, and 4.5-unit shadow casters ----------
  const trees = tiles.find(SLUG, { category: 'tree' }).filter((m) => (m.w ?? 1) <= 2);
  if (trees.length) {
    const line = [[21, 10], [22, 15], [21, 20], [33, 12], [37, 22], [41, 25],
      [35, 30], [39, 33], [16, 31], [13, 27], [44, 15], [26, 4]];
    line.forEach(([cx, cz], i) => draft.place(trees[i % trees.length], cx, cz, { layer: 3 }));
  }

  // --- flowers: a saturated accent for the grade to be judged on ------------
  const flowers = tiles.find(SLUG, { category: 'plant' })
    .filter((m) => /flower|hana/i.test(m.name));
  if (flowers.length) {
    draft.scatter(rng, (cx, cz) => flowers[(cx * 7 + cz * 13) % flowers.length], {
      rect: { x: 32, z: 24, w: 12, h: 12 }, chance: 0.18,
      opts: { layer: 3, collision: 'none' },
    });
    draft.scatter(rng, (cx, cz) => flowers[(cx + cz * 5) % flowers.length], {
      rect: { x: 14, z: 26, w: 9, h: 10 }, chance: 0.16,
      opts: { layer: 3, collision: 'none' },
    });
  }

  // --- street lamps ---------------------------------------------------------
  // A cobra head reaches a full cell sideways off its post (DECISIONS #25), and which way it
  // reaches decides whether its pool lands on the road or on the verge the post stands in.
  // Round 2 registered every bulb at the *cell centre* and the road never got a pool: the
  // critic's own column scan down the middle of the carriageway (x 790) oscillated 66..86,
  // 1.3:1, across a row of six lamps — and it still would, because the light was landing a
  // metre and a half to the side of where they were looking. The lamps flanking the road now
  // take the orientation whose arm reaches *in* over the kerb, and the bulb is derived from
  // the model's own bounds rather than assumed.
  const lampAt = (cx) => (cx < ROAD_CX ? 'e' : cx > ROAD_CX ? 'w' : 's');
  const lampCells = [[24, 13], [30, 13], [24, 19], [30, 19],
    [24, 26], [30, 26], [19, 29], [36, 27], [27, 34]];
  const lampModelFor = (cx) => first({ category: 'light', orientation: lampAt(cx) })
                            ?? first({ category: 'light' });
  for (const [cx, cz] of lampCells) {
    const m = lampModelFor(cx);
    if (m) draft.place(m, cx, cz, { layer: 3 });
  }

  draft.finalize();
  tiles.buildInstances(ctx.three.scene, SLUG, draft.placements, { name: 'showcase:env' });

  env.lamps.clear();
  for (const [cx, cz] of lampCells) {
    const b = bulbOf(lampModelFor(cx), cx, cz);
    env.lamps.add({
      x: b.x, y: b.y, z: b.z,
      color: 0xffab55, intensity: 1.6, radius: 12, size: 0.9,
    });
  }

  ctx.three.rig.frame(27.5, 23, 0, 34);

  // --- modes ----------------------------------------------------------------
  if (mode && mode !== 'default') {
    const [name, arg] = String(mode).split(':');
    if (name === 'weather') env.setWeather(arg || 'rain', 0.85);
    else if (name === 'biome') env.setBiomePreset(arg || 'forest');
    else if (!env.preset(name)) ctx.log?.warn?.(`environment showcase: unknown mode "${mode}"`);
  }
}
