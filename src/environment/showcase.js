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
 */

const SLUG = 'bw2-adastra';

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

export async function showcaseEnvironment(mode, ctx) {
  const tiles = ctx.get('tiles');
  const env = ctx.get('environment');
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
