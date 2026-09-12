/**
 * The Pokemon Center interior's author function — the base tileset half (`pt-house-indoor`).
 *
 * Floor, walls and the counter all come from one tileset and go through this draft, exactly
 * as `city/map.js` paints AdAstra's lawn and roads. The window and the benches live in
 * *other* tilesets — `hgss-newbark-houses` and `bw2-adastra` — so `dress.js` builds them as
 * their own `InstancedWorld`s; this file still reserves their footprints' collision and tags,
 * the same "reserved, not placed" split `city/map.js` uses for its own buildings and props.
 */

import {
  TILESET, EXIT, EXIT_TAG, SPAWN, WINDOW, COUNTER, BENCHES,
} from './layout.js';

export { TILESET };

/** Picks the first match and says so loudly rather than silently placing nothing. */
function pick(tiles, slug, query, log, label) {
  const found = tiles.find(slug, query);
  if (!found.length) { log.warn(`pokecenter: no tile matches ${label ?? JSON.stringify(query)}`); return null; }
  return found[0];
}

/**
 * `house_wall_side`/`house_wall_side_v2` carry no tag or orientation telling them apart —
 * PDSMS never recorded the difference, and `tiles`' own `overhangOf` cannot derive one either
 * (a flush slab has no overhang to measure: its far face sits exactly on its own footprint
 * edge). Their *bounds* still do — one slab's plane sits at local x=0, the other's at x=1,
 * confirmed by direct catalog read. Bounds are a derived property of the geometry, not a
 * name, so this keeps category/tag selection rather than reaching for `tiles.byName` — that
 * escape hatch is for the authored `structures`/`props` sets, not a PDSMS pack (CLAUDE.md).
 *
 * Which one goes on which side follows the same face-normal arithmetic as the north wall's
 * `rot:2` below: every face in this pack is single-sided (`tiles/instanced.js` builds
 * `THREE.FrontSide` materials), so the **west** wall wants the slab whose own normal is
 * `+x` — `house_wall_side` (bounds `x:1`) — and the **east** wall the one whose normal is
 * `-x` — `house_wall_side_v2` (`x:0`). Screenshotted either way round, though, and it barely
 * matters: this room's camera sits at `x ≈` the trainer's own x, so a wall running
 * north-south is seen almost end-on (the camera's offset from it is nearly all height and
 * depth, almost none of the sideways distance the face's normal needs). On the building next door, the
 * roof and the front wall read, the side walls do not, and nobody has ever added one for it.
 * Placed correctly anyway, because the geometry is real and the collision needs a model to
 * hang off; it is a minor line in a room whose window wall is what a camera on this project
 * can actually show. Keep this camera constraint in mind for other rooms so it does
 * not have to be re-discovered by screenshot.
 */
function sideWall(tiles, slug, face) {
  const sides = tiles.find(slug, { category: 'building', subcategory: 'house_wall_side' });
  const x = face === 'w' ? 1 : 0;
  return sides.find((m) => m.bounds?.min?.[0] === x && m.bounds?.max?.[0] === x) ?? null;
}

export async function buildPokecenterMap(draft, ctx) {
  const tiles = ctx.get('tiles');
  const { log } = ctx;
  const slug = draft.tileset;
  await tiles.load(slug);

  const W = draft.w, H = draft.h;

  // --- the floor --------------------------------------------------------------
  // Ten `wooden_floor` variants, picked deterministically per cell the same way
  // `city/map.js` varies its lawn. Never mixed with the `_slash` diagonal family: a plank
  // run that turns diagonal at random reads as damage, not as variety.
  const floors = tiles.find(slug, { category: 'interior', subcategory: 'wooden_floor' });
  const floorBase = floors[0] ?? pick(tiles, slug, { category: 'interior' }, log, 'a floor');
  draft.fill({ x: 0, z: 0, w: W, h: H },
    (cx, cz) => (floors.length ? tiles.pick(floors, cx, cz, { salt: 13 }) : floorBase),
    { collision: 'walk' });

  // --- the counter ------------------------------------------------------------
  // The pack's one furniture piece. `subcategory`, never `category`: id 70's own category is
  // the classifier's leftover bucket `'unknown'` (confirmed by direct catalog read), which
  // `tiles.find({category:'interior'})` would silently miss.
  const table = pick(tiles, slug, { subcategory: 'table' }, log, 'the counter');
  if (table) draft.place(table, COUNTER.cx, COUNTER.cz, {});
  // The `player:interact` trigger: facing any of the counter's 3 cells from the south opens
  // the same dialogue with Nurse Joy (`index.js`'s listener just checks for this tag).
  for (let i = 0; i < COUNTER.w; i++) draft.addTag(COUNTER.cx + i, COUNTER.cz, 'counter');

  // --- the walls ----------------------------------------------------------------
  // Three sides only — see layout.js's header for why the south side is collision without
  // geometry. `house_wall`'s plain (unoriented) variants run the top row, the one this
  // camera actually frames (see `sideWall`'s header); the two `house_wall_c_*` corner caps
  // close its ends; `house_wall_side`/`_v2` run the full height of the west and east columns,
  // corner rows included, real geometry standing behind the collision even where the camera
  // reads it as barely more than a seam next to the north wall's corner.
  //
  // Every one of `house_wall`'s three variants has a single `vn 0 0 -1` — one face, and it
  // faces away from this room's camera (see `sideWall`'s header for the same fact about the
  // side walls). `rot:2` turns it 180 degrees about its own cell centre, which flips the
  // normal to `+z` *and* slides its thin slab from the near edge of its cell to the far one
  // (`z:0..0.375` becomes `z:0.625..1`) — still row 0, just the half of it that borders row 1.
  const northPlain = tiles.find(slug, { category: 'building', subcategory: 'house_wall' })
    .filter((m) => !m.orientation);
  if (!northPlain.length) log.warn('pokecenter: no plain house_wall — the north wall is a hole');
  // The corner names and which corner they sit in are two different questions once `rot:2`
  // is in play: `house_wall_c_e` un-rotated is `(-x,-z)`, and turned 180 degrees that is
  // `(+x,+z)` — exactly the pair the **west** corner needs (`+z` from the fix above, `+x`
  // from `sideWall`'s west wall). `house_wall_c_w` rotates to `(-x,+z)`, the **east** corner's
  // pair. Named for the corner they end up in, not for the letter in their own filename.
  const nwCorner = pick(tiles, slug,
    { category: 'building', subcategory: 'house_wall_c', orientation: 'e' }, log, 'the NW wall corner');
  const neCorner = pick(tiles, slug,
    { category: 'building', subcategory: 'house_wall_c', orientation: 'w' }, log, 'the NE wall corner');
  const westWall = sideWall(tiles, slug, 'w');
  const eastWall = sideWall(tiles, slug, 'e');
  if (!westWall) log.warn('pokecenter: no west-facing house_wall_side — the west wall is a hole');
  if (!eastWall) log.warn('pokecenter: no east-facing house_wall_side — the east wall is a hole');

  const windowEnd = WINDOW.cx + WINDOW.w;
  for (let cx = 1; cx < W - 1; cx++) {
    // The window's own glass (`hgss-newbark-houses`, its own `InstancedWorld` in `dress.js`)
    // is a flat pane spanning y 0.25..1.75 out of the wall's 2.875 — on its own, the rest of
    // that column (the sill, the lintel, everything either side of the glass) would be an
    // open gap the void showed through. The plain wall still goes up behind it here; only
    // the tag is added for the window cells, marking which columns carry glass in front of it.
    if (cx >= WINDOW.cx && cx < windowEnd) draft.addTag(cx, 0, 'window');
    if (northPlain.length) draft.place(tiles.pick(northPlain, cx, 0, { salt: 19 }), cx, 0, { rot: 2 });
  }
  if (nwCorner) draft.place(nwCorner, 0, 0, { rot: 2 });
  if (neCorner) draft.place(neCorner, W - 1, 0, { rot: 2 });
  for (let cz = 0; cz < H; cz++) {
    if (westWall) draft.place(westWall, 0, cz, {});
    if (eastWall) draft.place(eastWall, W - 1, cz, {});
  }

  // --- the benches' ground ------------------------------------------------
  // Reserved, not placed: `bw2-adastra` geometry, drawn from the same cells in `dress.js`.
  for (const b of BENCHES) {
    if (!draft.inside(b.cx, b.cz)) continue;
    draft.setCollision(b.cx, b.cz, 'block');
    draft.addTag(b.cx, b.cz, 'bench');
  }

  // --- the door back to the city ---------------------------------------------
  // The room's fourth side has no wall (see the header), so every other cell in that row is
  // already ordinary walkable floor — nothing needs blocking there. This is the one cell
  // that also carries a tag, the same way the city's own door cells do.
  draft.setCollision(EXIT.cx, EXIT.cz, 'door');
  draft.addTag(EXIT.cx, EXIT.cz, EXIT_TAG);
  draft.mark('exit', EXIT.cx, EXIT.cz);

  // --- spawn -------------------------------------------------------------------
  draft.spawn = { ...SPAWN };

  log.info(`pokecenter: ${draft.placements.length} placements on ${W}x${H}`);
}
