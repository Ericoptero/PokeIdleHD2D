/**
 * The town, as data.
 *
 * Everything about *where things are* lives here, in one place, because three different
 * consumers need to agree on it and none of them may guess:
 *
 *   - `map.js` paints the ground, reserves the footprints and writes the collision;
 *   - `structures.js` places the authored buildings and the adapted props, which live in
 *     their own tilesets and therefore in their own instanced worlds (`tiles.buildInstances`
 *     takes exactly one tileset, so a building cannot go through the terrain draft);
 *   - `npcs.js` stands the cast on cells the first two agreed are walkable.
 *
 * The numbers are not arbitrary. The camera is fixed (`fov 26`, pitch 45, distance 30), so
 * at 16:9 it sees roughly **x ±12.5 and z −12.7 … +8.0 around its focus**, and a point at
 * height `h` lands on screen where ground at `z − h` would. A 4.5-tall Pokemon Center roof
 * is therefore only in frame if its ridge sits at `z >= focus − 5.5`. Every building below
 * is placed against that arithmetic and then checked on screen.
 */

export const CITY_SIZE = 64;

/**
 * Where the trainer stands when the lobby is entered — and so, since the camera follows the
 * trainer, the centre of every default screenshot. Facing north, at the mouth of the street
 * between the Pokemon Center and the Mart.
 */
export const SPAWN = { cx: 31, cz: 40, dir: 2 };

/**
 * Authored buildings (`tiles.load('structures')`).
 *
 * `x`/`z` is the north-west cell of the footprint. The model record carries `w`, `h` and a
 * `door` offset; the *cell* the door stands in is derived from that offset in
 * `doorCellOf()` below rather than written out here, so a re-export of the art moves the
 * marker with it.
 */
export const PLOTS = [
  { id: 'pokecenter', kind: 'pokemon_center', x: 22, z: 34 },
  { id: 'mart', kind: 'poke_mart', x: 34, z: 35 },
  { id: 'house-nw', kind: 'house', x: 21, z: 27 },
  { id: 'house-ne', kind: 'house', x: 36, z: 27 },
  { id: 'house-sw', kind: 'house', x: 16, z: 52 },
  { id: 'house-se', kind: 'house', x: 43, z: 52 },
];

/**
 * A plot names a **subcategory**, never a model name. `tiles.find` logs a warning every time
 * anything is selected by name, because a model is named after its dominant texture and that
 * is an implementation detail of the build; a subcategory is the stable handle
 * the authored pack carries on purpose. So the query is
 * `tiles.find('structures', { category: 'building', subcategory: plot.kind })`.
 */
export const plotModel = (tiles, plot) =>
  tiles.find('structures', { category: 'building', subcategory: plot.kind })[0] ?? null;

/**
 * The door's own cell.
 *
 * `meta.door` is the *west edge* of the door quad in model space, not a cell index: the
 * Center's door spans x 3.0–5.0 and stores 3, the Mart's spans 3.6–5.2 and stores 3.6, the
 * house's spans 1.9–3.1 and stores 1.9. Rounding the quad's near edge up by half a cell
 * lands on the cell the door actually fills in all three cases (3, 4, 2 respectively) —
 * `floor(3.6)` would have put the Mart's marker half a cell off its own doorway.
 */
export function doorCellOf(plot, model) {
  const dx = Math.floor((model?.door?.[0] ?? (model?.w ?? 1) / 2) + 0.5);
  const dz = Math.round(model?.door?.[1] ?? (model?.h ?? 1) - 1);
  return { cx: plot.x + dx, cz: plot.z + dz };
}

// --- the ground plan --------------------------------------------------------

/** The paved town square. Its north edge is the pavement in front of the two shops. */
export const PLAZA = { x: 22, z: 40, w: 22, h: 8 };

/**
 * Stone paving inside the square, inset one cell east, west and south so the square keeps a
 * gravel rim. It runs all the way to the shopfronts on the north edge on purpose: a rim
 * there would draw a hard tan line straight across the frame at exactly the height the
 * buildings meet the ground, which reads as a seam rather than as a kerb.
 */
export const PLAZA_STONE = { x: 23, z: 40, w: 20, h: 7 };

/**
 * What the square is actually paved with — and it is **not** an AdAstra tile.
 *
 * Every `path`/`ground` texture AdAstra ships is dirt: `michi01a/b` and `michi03a/b` are the
 * two beaten tracks, `michi_hibi`/`michi_hage` are bald patches, and `gake_michi` — which
 * this square used to be laid in — is the *cliff* path, a 64x64 smear of soft brown blotches
 * with no joint, no course and no edge. Sampled at `uvScale 0.25` and shifted by the
 * instancer's per-cell texel phase, twenty by seven cells of it is mud with the grain
 * scrambled, which is exactly what it read as.
 *
 * `pt-overworld-7` ships a real one: **`set21`**, a thirteen-slot blob palette of pale
 * blue-grey paving (`blueglay_lm52`, 16x16 for one cell — the same 16 texels per world unit
 * AdAstra's own roads use). `edged` is false: the palette's transition ring is drawn with a
 * bright green grass fringe, and ringing the square in it reads as a bowling green. The square's
 * border course is the gravel rim it is already inset from. Another set fills gaps in AdAstra, with each piece adapted to AdAstra's silhouette
 * language — and every slot here is a **flat two-triangle floor quad at y = 0**, so there is
 * no silhouette to adapt and none of the leaning-sprite problem in the source sprites. It
 * is a floor, and a floor is the one thing that ports.
 *
 * It lives in its own `InstancedWorld` for the same reason the buildings do: a `Placement`
 * names a model id and `buildInstances` resolves it against exactly one tileset
 *.
 */
export const PAVING = { tileset: 'pt-overworld-7', set: 'set21', y: 0.10, edged: false };

/** Roads. The high street runs north between the two shops and south out of town. */
export const ROADS = [
  { x: 30, z: 22, w: 4, h: 18 },     // north street, between the Center and the Mart
  { x: 30, z: 47, w: 4, h: 15 },     // south road, out of the plaza
  { x: 4, z: 42, w: 19, h: 4 },      // west lane
  { x: 43, z: 42, w: 17, h: 4 },     // east lane
  { x: 22, z: 31, w: 9, h: 3 },      // north-west spur, to the cottage
  { x: 33, z: 31, w: 9, h: 3 },      // north-east spur
  { x: 16, z: 56, w: 31, h: 3 },     // southern lane linking the two cottages
];

/**
 * A pond in the north-east meadow, kept out of the square.
 *
 * `set` is AdAstra's lake palette. It is named here rather than inline in `map.js` because
 * the pond is the one region on this map whose geometry *descends*: every slot runs from
 * y 0 at the bank down to y −0.75, and the water sheet itself is a flat quad at −0.5. The
 * lawn is a quad at y 0, so laying the lake on top of an unbroken lawn buries the whole
 * thing — which is precisely what happened in round 1. See `buildCityMap`.
 */
export const POND = { cx: 50, cz: 16, rx: 6.5, rz: 4.5, set: 'set1' };

/**
 * The square's landmark: two hedge-walled flower beds either side of the road, so the high
 * street runs *through* the square instead of stopping at it. Nothing here is tall — a tree
 * in the middle of the plaza would sit at z 45 with a 4.7 m canopy, which at a 45-degree
 * camera lands exactly on top of the Pokemon Center's facade and hides the thing the whole
 * scene is about.
 */
export const PLANTERS = [
  { x: 24, z: 43, w: 5, h: 3 },
  { x: 35, z: 43, w: 5, h: 3 },
];

/**
 * A public garden on the west lawn.
 *
 * The `garden` preset used to frame eight hundred square metres of nothing — the west side
 * of the map had a patch of tall grass in it and no reason to exist. Three hedged beds and a
 * fence turn it into somewhere, and it gives the lobby a second composed corner that is not
 * the square. Each bed is a hedge run along its north edge with one course of flowers in
 * front, exactly as the plaza's planters are, so the two read as the same town's planting.
 */
export const GARDEN_BEDS = [
  { x: 8, z: 33, w: 4, h: 2 },
  { x: 13, z: 33, w: 3, h: 2 },
  { x: 9, z: 36, w: 5, h: 2 },
];

/** Trees standing outside the paving, closing the left and right of the default framing. */
export const TOWN_TREES = [
  { cx: 19, cz: 41 }, { cx: 19, cz: 45 }, { cx: 44, cz: 45 },
  { cx: 18, cz: 36 }, { cx: 45, cz: 33 },
  // Nearest the camera, at the bottom corners: dark foliage in the near field is what gives
  // `docs/refs/03` its depth, and an open square with nothing in front of it reads flat.
  { cx: 19, cz: 49 }, { cx: 44, cz: 49 },
];

/** Tall grass, so the lobby has somewhere the lead Pokemon can actually meet something. */
export const TALL_GRASS = [
  { x: 6, z: 26, w: 7, h: 6 },
  { x: 50, z: 50, w: 8, h: 6 },
];

// --- street furniture -------------------------------------------------------

/**
 * Street lamps, and which way each one's head points.
 *
 * **The lamp is `structures`' authored `street_lamp`, not AdAstra's `lamp_h`.** Round 2 read
 * the obelisk as a placement bug and rotated its way out of the foreshortening; two
 * whole-game passes and a blind judge then all named the same thing first, and from close
 * range they were right about the cause. `slamp03.png` is 16x32 with **ten** colours — a
 * flat blue-grey swatch — and AdAstra's `lamp_h` is two alpha-tested cards wearing it, so
 * however it is turned it is a plain grey pole with a flat lozenge on top: no bulb, no
 * housing, no fixture. There is no rotation of nothing that becomes something.
 *
 * `tiles.find('structures', { category: 'light', subcategory: 'street_lamp' })` is the
 * replacement: 64 triangles of real geometry, a post with cast collar rings and lit/shaded
 * columns, a three-box cobra arm, and a cowled head whose lens is its own material with
 * `Ke 0.9`, so it lights at dusk exactly the way the Centre's windows do
 * without the city knowing the hour.
 *
 * It ships in **one** flavour — the arm reaching east — so `head` is served by a quarter
 * turn rather than by a fourth model: `lampRotFor()` derives the turn from the model's own
 * `orientation` against the letter asked for here. `'e'` and `'w'` remain the only two
 * letters used, and that camera constraint still holds: the camera's yaw is fixed, so a
 * north- or south-pointing arm foreshortens down its own post and hides the silhouette that
 * is the whole point of the new art.
 *
 * **And they are never placed in opposing pairs.** That was the round-1 mistake and it was
 * worse than the obelisk it replaced: an `'e'` lamp at cx 30 with a `'w'` lamp at cx 33 puts
 * two cantilevered arms three cells apart at the same y reaching towards each other over a
 * four-wide road, and at a fixed 45-degree camera the pair closes into a single rugby
 * goalpost.
 *
 * The rule now: **one lamp per stretch of road, alternating sides as it runs**, with at
 * least four cells of `z` between a lamp and the nearest lamp on the other side. The posts
 * also stand on the verge (cx 29 / cx 34) rather than on the carriageway (cx 30–33), so the
 * arm reaches *in* over the kerb the way a real cobra head does instead of spanning the
 * road. Count is down from twelve to eleven, which also matters at night: `environment`
 * hands a `PointLight` to only the eight bulbs nearest the camera and a lit shop window is
 * a bulb too, so every lamp that is not in shot is one that is stealing a slot from one
 * that is (the plaza framing is the case that failed).
 */
export const LAMPS = [
  // The square. Two on the rim and two standing in the paving itself, so the middle of the
  // square is lit rather than only its edges.
  { cx: 23, cz: 41, head: 'e' },
  { cx: 37, cz: 42, head: 'w' },
  { cx: 28, cz: 46, head: 'w' },
  { cx: 42, cz: 45, head: 'w' },
  { cx: 34, cz: 47, head: 'w' },   // where the south road leaves the square
  // The high street, on the verge either side of the kerb, alternating sides going north.
  { cx: 29, cz: 30, head: 'e' },
  { cx: 34, cz: 26, head: 'w' },
  { cx: 29, cz: 22, head: 'e' },
  // The south road, the same way.
  { cx: 29, cz: 50, head: 'e' },
  { cx: 34, cz: 55, head: 'w' },
  { cx: 29, cz: 60, head: 'e' },
];

/**
 * Nothing stands in the four cells of the street between the two shops. The arm reaches a
 * full cell sideways at y 3.4 and the Pokemon Center's roof overhangs its own footprint by
 * 0.45, so a post on the street's edge would grow through the eaves — and a lamp in the
 * middle of a four-wide street crosses the frame at exactly the height of the shopfronts,
 * which is where the eye wants to read the buildings. The street is lit from its ends.
 */

/**
 * Hedge tubs along the pavement, either side of each shop's door. AdAstra's `hedge1`, not
 * one of the adapted props — see the note in `PROPS`.
 */
export const TUBS = [
  { cx: 23, cz: 40 }, { cx: 29, cz: 40 },
  { cx: 33, cz: 40 }, { cx: 40, cz: 40 },
  { cx: 22, cz: 44 }, { cx: 43, cz: 45 },
];

/** Benches, facing the planter and the shopfronts. `dir` names the way the seat faces. */
export const BENCHES = [
  { cx: 24, cz: 42, face: 's' }, { cx: 27, cz: 42, face: 's' },
  { cx: 36, cz: 42, face: 's' }, { cx: 39, cz: 42, face: 's' },
  { cx: 25, cz: 46, face: 'n' }, { cx: 38, cz: 46, face: 'n' },
];

/**
 * Adapted props (`tiles.load('props')`). Real geometry that casts a
 * real shadow, so they are dressing with weight rather than decals.
 */
export const PROPS = [
  // NOTE: `props/pt-forest__hedge` and `props/pt-overworld-7__hedge` are deliberately not
  // used. Both render as a pale grey blob roughly a third of a cell across with a blue rim,
  // in this map and in `?showcase=preview&mode=props&filter=hedge` alike, although their
  // catalog record claims a 1x1x0.86 bush. The greenery here is AdAstra's own `hedge1`
  // instead (see `TUBS`), and the two broken props are still broken.

  // The Mart's delivery yard: stock stacked against the shop's own east wall (x 39) inside
  // the fence run below, so it reads as a yard rather than as four unrelated objects
  // dropped on open lawn.
  { model: 'sylvan-town__barrel', cx: 40, cz: 36 },
  { model: 'sylvan-town__barrel', cx: 41, cz: 36 },
  { model: 'sylvan-town__barrel', cx: 41, cz: 37 },
  { model: 'sylvan-town__log', cx: 40, cz: 37 },
  { model: 'sylvan-town__log', cx: 40, cz: 38 },
  // The west cottage's woodyard, against its own west wall (x 16) and fenced the same way.
  { model: 'sylvan-town__pile_of_logs', cx: 13, cz: 52 },
  { model: 'sylvan-town__fat_log', cx: 13, cz: 54 },
  { model: 'sylvan-town__axe', cx: 15, cz: 54 },
  { model: 'sylvan-town__barrel', cx: 15, cz: 52 },
  // Boulders in threes where the lawn runs out into the wood, never singly: one rock on a
  // lawn is litter, three of different sizes is an outcrop.
  { model: 'sylvan-town__rock_tall', cx: 47, cz: 33 },
  { model: 'sylvan-town__rock_small', cx: 48, cz: 34 },
  { model: 'bw2-twist__small_rock', cx: 47, cz: 35 },
  { model: 'sylvan-town__rock_small', cx: 18, cz: 33 },
  { model: 'bw2-twist__small_rock', cx: 17, cz: 34 },
  // On the pond's shore, not in it: the lake bed is at y -0.75 and the sheet at -0.5, so a
  // prop placed inside the ellipse at y 0 hovers over open water.
  { model: 'hgss-overworld__water_rock_small', cx: 46, cz: 21 },
  { model: 'hgss-overworld__water_rock_small', cx: 54, cz: 20 },
  // `sylvan-town__tree_mush` is **not** placed either, for the same reason as the two
  // hedges. It is one of the two crossed-billboard rebuilds that already form the
  // weakest of the fifteen, and on screen at noon it is a flat near-black leaf standing on
  // the lawn. It needs to be re-cut before use.
];

/**
 * Fence runs, as cells. `tiles` solves a fence by the arms its geometry actually has rather
 * than by a blob slot (`armsOf`), so a run is just the list of cells it
 * passes through and the corners resolve themselves.
 *
 * Both runs are open on the side that faces their building, so each reads as a yard *of*
 * that building rather than as a pen standing on its own.
 */
export const FENCES = [
  // The Mart's yard: east side and the south return, open to the north where the deliveries
  // come in off the north-east spur.
  { cx: 42, cz: 36 }, { cx: 42, cz: 37 }, { cx: 42, cz: 38 }, { cx: 42, cz: 39 },
  { cx: 41, cz: 39 },
  // The west cottage's woodyard: west side and the south return.
  { cx: 12, cz: 51 }, { cx: 12, cz: 52 }, { cx: 12, cz: 53 }, { cx: 12, cz: 54 },
  { cx: 12, cz: 55 }, { cx: 13, cz: 55 }, { cx: 14, cz: 55 },
  // The garden: north edge and the west return, open to the south so the beds are not seen
  // through a rail from a camera that looks north.
  { cx: 7, cz: 32 }, { cx: 8, cz: 32 }, { cx: 9, cz: 32 }, { cx: 10, cz: 32 },
  { cx: 11, cz: 32 }, { cx: 12, cz: 32 }, { cx: 13, cz: 32 }, { cx: 14, cz: 32 },
  { cx: 15, cz: 32 }, { cx: 16, cz: 32 },
  { cx: 7, cz: 33 }, { cx: 7, cz: 34 }, { cx: 7, cz: 35 }, { cx: 7, cz: 36 },
  { cx: 7, cz: 37 }, { cx: 7, cz: 38 },
];

// --- practical lights -------------------------------------------------------

/**
 * Lit doorways, in *model* space, keyed by the plot's `kind`.
 *
 * Deliberately **one per shop and none on the cottages**. The windows light themselves now:
 * `tiles` reads the authored `Ke` out of the MTL and ramps it with the hour,
 * so a Poke Center window is emissive without the city asking. What emissive cannot do is put
 * light on the *ground*, so each shop keeps one warm bulb in its doorway for the pool of light
 * spilling onto the pavement.
 *
 * Every extra bulb here is one fewer street lamp with a real point light: `environment` gives
 * a glow quad to all of them but a `PointLight` only to the eight nearest the camera, and at
 * the default framing there are already twelve lamps competing for those eight.
 */
export const WINDOW_GLOWS = {
  pokemon_center: [{ x: 4.0, y: 1.3, z: 6.15, color: 0xffd8a0, intensity: 0.50, radius: 7.5, size: 0.22 }],
  poke_mart: [{ x: 4.4, y: 1.2, z: 5.15, color: 0xffd8a0, intensity: 0.42, radius: 6.5, size: 0.20 }],
  house: [],
};

/**
 * Which quarter turn puts a model's overhang on the compass point asked for.
 *
 * `tiles` derives `model.orientation` from the model's own bounds against its footprint
 * (`overhangOf`), and `InstancedWorld.composeMatrix` turns a placement by
 * `-rot * 90°` about +Y — which sends **east to south to west to north** as `rot` counts up.
 * So the turn is a subtraction on that cycle, and nothing here has to know that the authored
 * lamp happens to ship arm-east: re-export it pointing north and every lamp still lands the
 * way `LAMPS` asks for.
 *
 * @param {{orientation?:string|null}} model
 * @param {'n'|'s'|'e'|'w'} head  which way the arm should overhang
 * @returns {0|1|2|3}
 */
const ROT_CYCLE = ['e', 's', 'w', 'n'];
export function lampRotFor(model, head) {
  const from = ROT_CYCLE.indexOf(model?.orientation ?? 'e');
  const to = ROT_CYCLE.indexOf(head);
  if (from < 0 || to < 0) return 0;
  return /** @type {0|1|2|3} */ ((to - from + 4) & 3);
}

/**
 * Where a model's own geometry sits once the placement has turned it, in world space.
 *
 * `composeMatrix` rotates about the **footprint centre** and then stands that centre on the
 * cells, which for a 1x1 piece is exactly "spin the model about the middle of its cell".
 * Reproduced here rather than shared, because `tiles` exposes the matrix only through the
 * instanced world it has already built and a light has to be registered from the same
 * numbers the mesh was placed with or the glow floats off the lamp.
 */
function rotateInCell(px, pz, cx, cz, rot, w = 1, h = 1) {
  const r = rot & 3;
  const t = -r * Math.PI * 0.5;
  const cos = Math.round(Math.cos(t)), sin = Math.round(Math.sin(t));
  const halfW = w / 2, halfH = h / 2;
  // A quarter turn swaps the footprint's extents, so the centre the turn happens about is
  // the *turned* footprint's centre — exactly what `composeMatrix` does with `rot & 1`.
  const ox = px - halfW, oz = pz - halfH;
  return {
    x: cx + ((r & 1) ? halfH : halfW) + (ox * cos + oz * sin),
    z: cz + ((r & 1) ? halfW : halfH) + (-ox * sin + oz * cos),
  };
}

/**
 * The lamp's bulb — the centre of the piece of geometry that actually lights.
 *
 * Not the model's bounds. The old heuristic ("half a cell short of the far end, a little
 * below the top") was fitted to AdAstra's card and is 0.26 west and 0.19 high of the
 * authored fixture's lens, which is a quarter of a cell of daylight between the glow quad
 * and the thing it is supposed to be coming out of. The pack says which materials emit
 * (`emissiveMaterials`, the same list `tiles` ramps at dusk), and each material is its own
 * geometry group with its own bounding sphere, so the lens's centre is a lookup rather than
 * a guess — and it moves with the art if the art is re-cut.
 *
 * @param {object} tileset  the loaded tileset (`tiles.get('structures')`)
 * @param {object} model    the lamp model
 * @param {number} cx @param {number} cz @param {0|1|2|3} rot
 */
export function bulbOf(tileset, model, cx, cz, rot = 0) {
  const mats = tileset?.pack?.materials;
  const emissive = new Set(model?.emissiveMaterials ?? []);
  for (const g of model?.groups ?? []) {
    const full = mats?.[g.materialId]?.name ?? '';
    if (!emissive.has(full.split(':').pop())) continue;
    const c = g.geometry?.boundingSphere?.center;
    if (!c) continue;
    const p = rotateInCell(c.x, c.z, cx, cz, rot, model.w ?? 1, model.h ?? 1);
    return { x: p.x, y: c.y, z: p.z };
  }
  // No emissive group — an unlit post, or a pack that predates the convention. The bulb goes
  // at the far end of whatever the model overhangs, a little below its top.
  const b = model?.bounds;
  if (!b) return { x: cx + 0.5, y: 3.35, z: cz + 0.5 };
  const axis = (min, max) => (max > 1 ? max - 0.5 : (min < 0 ? min + 0.5 : 0.5));
  const p = rotateInCell(axis(b.min[0], b.max[0]), axis(b.min[2], b.max[2]),
    cx, cz, rot, model.w ?? 1, model.h ?? 1);
  return { x: p.x, y: b.max[1] - 0.22, z: p.z };
}

// --- the cast ---------------------------------------------------------------

/**
 * The lobby's population. Every entry is either still (a `dir` and nothing else) or walks a
 * scripted loop written in `simulation`'s route language, so the same seed and the same
 * number of sim steps put everybody in exactly the same place — which is what lets a
 * screenshot of a *moving* scene be a regression test.
 *
 * Cells were chosen against the ground plan above: none is a road a lamp stands in, none is
 * inside a footprint, and every scripted leg stays on paving.
 */
export const NPCS = [
  // --- people ---------------------------------------------------------------
  // Facing **south**, i.e. towards the lens. The camera's yaw is fixed looking north, so a
  // north-facing walker shows the back of a cap and nothing else — every human in the round-1
  // cast was posed that way and the town had no face in it. The trainer still faces north
  // because `cameraLookAhead` is 1.6 and turning the player re-frames every preset the
  // layout was measured against; the NPCs carry the front instead.
  { name: 'centre-queue', trainer: 'heroine', display: 'Visitor', cx: 26, cz: 41, dir: 0 },
  { name: 'mart-doorman', trainer: 'hero', display: 'Doorman', cx: 37, cz: 41, dir: 0 },
  { name: 'shopper', trainer: 'heroine', display: 'Shopper', cx: 38, cz: 45, dir: 1, route: 'w6 e6' },

  // --- Pokemon --------------------------------------------------------------
  { name: 'audino', species: 'audino', cx: 24, cz: 41, dir: 3 },
  { name: 'pikachu', species: 'pikachu', cx: 29, cz: 42, dir: 0 },
  { name: 'eevee', species: 'eevee', cx: 34, cz: 45, dir: 1, route: 'w2 e2' },
  { name: 'lillipup', species: 'lillipup', cx: 41, cz: 44, dir: 1 },
  { name: 'growlithe', species: 'growlithe', cx: 24, cz: 48, dir: 2 },
  { name: 'minccino', species: 'minccino', cx: 23, cz: 44, dir: 3 },
  { name: 'snubbull', species: 'snubbull', cx: 31, cz: 47, dir: 0 },
  { name: 'pidove', species: 'pidove', cx: 35, cz: 47, dir: 1 },
  { name: 'zigzagoon', species: 'zigzagoon', cx: 30, cz: 46, dir: 3, route: 'e3 w3' },
  { name: 'munna', species: 'munna', cx: 40, cz: 42, dir: 1 },
  { name: 'herdier', species: 'herdier', cx: 32, cz: 37, dir: 0, route: 's2 n2' },
];

/**
 * How the lobby is played (`simulation.setFormation`).
 *
 * The city is the one place the player drives: the **trainer leads** and the active Pokemon
 * walks behind it, WASD moves them, and nothing walks the party when the player does not.
 * A town where your avatar strolls off on its own is not a lobby, it is a cutscene — and the
 * autopilot that used to run here is what made two loads of the same URL disagree.
 *
 * It lives beside the spawn cell because it is map data in the same sense: it says how this
 * place is entered, not what `simulation` prefers.
 */
export const FORMATION = { head: 'trainer', input: true, autopilot: 'none' };

/**
 * Named camera framings the screenshot harness can ask for by name (src/main.js).
 * A preset is a *focus cell*, because the camera has no other degree of freedom.
 */
export const PRESETS = {
  default: { cx: SPAWN.cx, cz: SPAWN.cz },
  plaza: { cx: 32, cz: 42 },
  centre: { cx: 26, cz: 42 },
  pokecenter: { cx: 26, cz: 42 },
  mart: { cx: 37, cz: 43 },
  'high-street': { cx: 31, cz: 33 },
  'south-gate': { cx: 31, cz: 52 },
  // The camera sees roughly `focus − 12.7 … focus + 8.0` in z, so framing a feature that
  // spans z 12–20 means standing at its southern shore, not at its centre.
  pond: { cx: 50, cz: 21 },
  'wood-yard': { cx: 41, cz: 41 },
  garden: { cx: 12, cz: 39 },
};

/** Cells a rectangle covers, as a predicate. */
export const inRect = (r) => (cx, cz) => cx >= r.x && cx < r.x + r.w && cz >= r.z && cz < r.z + r.h;
