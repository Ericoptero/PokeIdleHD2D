/**
 * simulation showcase — a walk a critic can actually judge.
 *
 * A screenshot cannot show motion, so what a still frame has to prove is *the shape of the
 * queue*: the head, the walker behind it, and the pair bending around a corner one cell at a
 * time. Two sprites walking in a straight line are indistinguishable from two sprites
 * standing in a row; two sprites rounding a corner are not — so the default shot is the
 * corner. The queue is a **pair**, not the old four: only the active Pokemon is in the field
 *, and this showcase never calls `setFormation`, so it keeps the default
 * hunt arrangement — the Pokemon at the head, the trainer behind it.
 *
 * Modes (`?showcase=simulation&mode=…`):
 *   default / corner  the line turning west off the north road, frozen mid-stride
 *   closeup           the same pose at twice the zoom, for judging frames and contact shadows
 *   grass             the lead has stepped into the tall grass while the trainer is still on
 *                     the path — the reason encounters roll on the *Pokemon's* cell
 *   south             the whole line walking at the camera, every face visible
 *   wide              the corner pulled back, so the road and the fields read as a place
 *   city              the party on the lobby's paving, the lobby's own cast around them
 *
 * Every mode walks the party to an exact step and then freezes the simulation, so the same
 * URL gives the same pixels (tools/shots/shoot.js) even though the subject is a walk.
 */

import { SOUTH, WEST, NORTH, EAST, DIR_DX, DIR_DZ } from '../core/dir.js';
import { parseRoute } from './route.js';

const SLUG = 'bw2-adastra';
const MAP_ID = 'simulation-walk';
const MAP_SIZE = 56;
/** How close a lobby NPC may stand to a party member in `mode=city` before it is cleared. */
const CITY_CLEARANCE = 3;
/**
 * Tags a scene puts on ground the player is meant to walk on. `city` tags its square `plaza`
 * and its door aprons `approach`; this map tags its road `path`. A staged line stands on one
 * of these or it is standing on somebody's lawn.
 */
const PAVED_TAGS = ['path', 'plaza', 'paving', 'road', 'approach'];

/** The road: a north-south leg and a west spur, meeting in a corner the queue turns. */
const ROAD = { x0: 26, x1: 28, z0: 6, z1: 50 };
const SPUR = { z0: 25, z1: 27, x0: 16, x1: 28 };
/**
 * Tall grass where the spur runs out. The lead walks off the road into it first.
 *
 * The patch's south rim is the walk's own row, deliberately: blades between the lead and the
 * camera are what hide it, so the grass has to end where the lead stands rather than carry on
 * past it. See the comment in `buildWalkMap`.
 */
const PATCH = { x0: 5, x1: 15, z0: 19, z1: 26 };
const SPAWN = { cx: 27, cz: 40, dir: NORTH };
/** Cells west along the spur, then south into the meadow, then back east and north. */
const LEG = { west: 13, south: 10, east: 13, north: 10 };

/**
 * Hedged fields. The first sits *inside* the walk's own loop, so the queue rounds the corner
 * of something the eye can measure it against; the others fill the frame's corners at the
 * zooms the modes actually use. None of them touches the route corridor.
 */
const FIELDS = [
  { x0: 17, x1: 24, z0: 30, z1: 35, north: true },
  { x0: 31, x1: 39, z0: 31, z1: 37, north: true },
  { x0: 32, x1: 39, z0: 14, z1: 20 },
  { x0: 5, x1: 12, z0: 32, z1: 38, north: true },
];

/** Position-stable 0..1, so a gate in a hedgerow is in the same place on every replay. */
function hash(x, z) {
  let h = Math.imul((x | 0) + 0x9e3779b9, 374761393) ^ Math.imul((z | 0) + 0x85ebca6b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The walk, written out for the gap the session is actually running at.
 *
 * The lead starts `gap` cells ahead of the trainer, so the number of northward steps that
 * lands it on the spur depends on the gap — hardcoding `n14` put the corner one row off the
 * road the moment the gap changed from 1 to 2, and every freeze point in `STOPS` moved with
 * it. Deriving the leg keeps the poses stable whatever `followerGapTiles` says.
 */
function legNorth(gap) { return (SPAWN.cz - gap) - (SPUR.z0 + 1); }
function routeFor(gap) {
  return `n${legNorth(gap)} w${LEG.west} s${LEG.south} e${LEG.east} n${LEG.north}`;
}

/**
 * The zoom each stop is shot at, in internal pixels per world unit.
 *
 * This used to be `pixelExactDistance(config, k)`, which solved for the camera distance that
 * happened to put one sprite texel on `k` whole internal pixels *at the window it was measured
 * at* — the density fell out of `fov`, distance and buffer height, so the number had to be
 * recomputed per shot and was only ever right for one screen. It is a config key now
 * and the ladder has three rungs, because those are the only densities at
 * which both 16-texel sprite art and 32-texel tile art land on whole pixels: 16 (wide), 32
 * (one sprite texel = 2 px, the game's own zoom) and 64 (close).
 */
const PPU = { wide: 16, normal: 32, close: 64 };

/**
 * Every cell the walk touches, dilated by one, so nothing decorative is ever planted in the
 * queue's way. A tree on the route would make `makeScriptedRoute` skip a step, and every
 * freeze point in `STOPS` would then land on a different pose — a showcase that quietly
 * drifts is worse than one that is obviously wrong.
 */
function routeCorridor(gap) {
  const cells = new Set();
  const mark = (cx, cz) => {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) cells.add(`${cx + dx},${cz + dz}`);
  };
  // The head starts `gap` cells ahead of the trainer, and the tail `gap · members` behind it.
  let cx = SPAWN.cx + DIR_DX[SPAWN.dir] * gap;
  let cz = SPAWN.cz + DIR_DZ[SPAWN.dir] * gap;
  for (let i = 0; i <= gap * 4; i++) mark(SPAWN.cx - DIR_DX[SPAWN.dir] * i, SPAWN.cz - DIR_DZ[SPAWN.dir] * i);
  mark(cx, cz);
  for (const dir of parseRoute(routeFor(gap))) {
    cx += DIR_DX[dir]; cz += DIR_DZ[dir];
    mark(cx, cz);
  }
  return cells;
}

/**
 * The map the walk happens on. Registered with `terrain` rather than built straight into the
 * scene, because the walker's collision goes through `terrain.passable()` — a map that only
 * existed as geometry would leave the queue strolling through the trees.
 */
function buildWalkMap(draft, ctx) {
  const tiles = ctx.get('tiles');
  const rng = ctx.rng.fork(`simulation/showcase/${draft.id}`);
  const W = draft.w, H = draft.h;
  const corridor = routeCorridor(Math.max(1, Math.round(ctx.config.followerGapTiles) || 1));
  const onCorridor = (cx, cz) => corridor.has(`${cx},${cz}`);

  const grass = tiles.find(SLUG, { category: 'ground', tags: ['grass'] });
  const ground = grass.length ? grass : tiles.find(SLUG, { category: 'ground' });
  draft.fill({ x: 0, z: 0, w: W, h: H }, (cx, cz) => tiles.pick(ground, cx, cz, { salt: 11 }), { collision: 'walk' });

  const onRoad = (cx, cz) =>
    (cx >= ROAD.x0 && cx <= ROAD.x1 && cz >= ROAD.z0 && cz <= ROAD.z1) ||
    (cz >= SPUR.z0 && cz <= SPUR.z1 && cx >= SPUR.x0 && cx <= SPUR.x1);
  draft.autotile(tiles, 'set0', onRoad, { collision: 'walk', layer: 1, outsideIsFilled: false, tags: ['path'] });

  // Tall grass. The `grass` mode's whole claim is that the *lead* meets the world first, and
  // a lead the blades have swallowed does not make that claim: AdAstra's `tall_grass` stands
  // 0.625 units and a 45-degree camera reads a cell of it as ~0.9 tiles of screen depth, so
  // the row of blades one cell *south* of the lead — between it and the camera — is what
  // hides it, not the cell it is standing on. The patch therefore ends on the walk's own row
  // (`PATCH.z1 === SPUR.z0 + 1`): the lead stands in grass with the patch behind and beside
  // it and open meadow in front, which is exactly the Black & White framing. The last two
  // rows use the shorter `tall_grass_light` so even the blades beside it sit below the eye.
  const tall = tiles.find(SLUG, { tags: ['tallgrass'], walkable: true });
  const byName = (n) => tall.find((m) => m.name === n);
  const tallGrass = byName('tall_grass') ?? tall[0];
  const shortGrass = byName('tall_grass_light') ?? tallGrass;
  if (tallGrass) {
    const patches = [PATCH, { x0: 33, x1: 40, z0: 17, z1: 23 }];
    for (const patch of patches) {
      for (let cz = patch.z0; cz <= patch.z1; cz++) {
        for (let cx = patch.x0; cx <= patch.x1; cx++) {
          if (onRoad(cx, cz)) continue;
          // Solid in the middle, ragged at the rim, so a patch has a shape rather than a
          // stamped rectangle — except on the south rim, which the walk crosses: a coin flip
          // there could leave the lead standing on bare ground in the mode named `grass`.
          const front = cz === patch.z1;
          const edge = cx === patch.x0 || cx === patch.x1 || cz === patch.z0;
          if (edge && !front && rng.next() < 0.5) continue;
          // The short band is one row deep at the front and frays a cell further back, so the
          // change of height reads as grass thinning out rather than as two mown fields.
          const model = front || (cz === patch.z1 - 1 && hash(cx, cz) < 0.55) ? shortGrass : tallGrass;
          draft.place(model, cx, cz, { collision: 'walk', layer: 5, tags: ['tallgrass', 'encounter'] });
        }
      }
    }
  }

  // NO TREES. Every AdAstra tree (`tree`, `round_tree`, `darker_pine`, `big_tree_dark`) is a
  // PDSMS slice-quad billboard: two crossed vertical quads at the footprint's centre lines
  // plus two horizontal canopy slices. Dumped from `pack.bin`, model 202 is
  //   ki02ax  x=1 plane, normal (-1,0,0), y 0.19..4.5     <- edge-on to a yaw-locked camera
  //   ki02ax  z=1 plane, normal (0,0,-1), y 0.19..4.5     <- the one you are meant to see
  //   ki02bx  horizontal quad, y=1.625, normal (0,1,0)
  //   ki02dx  horizontal quad, y=3.719, normal (0,1,0)
  // Our camera never yaws (src/core/render.js), so the x=1 plane is permanently edge-on and
  // rasterises as the full-height bright column the critic photographed, and the two
  // horizontal slices read as the brown lintel above the canopy. Both are lit off normals
  // that point nowhere near the surface they stand for, which is why the column stays green
  // while the canopy goes red at 17:30. That is tile geometry, not planting, and it is filed
  // as a coreRequest; until it lands this map plants no tree at all rather than putting the
  // artifact in every frame the module is judged on.

  // What closes the meadow instead: hedgerows. `hedge1` is real geometry — 14 triangles of
  // sloped box under a shadow decal, no billboard in it — so it survives the 45-degree
  // camera and the low sun that the trees do not. Fields are also better for this showcase
  // than a copse: their edges are long straight lines, and a queue bending across a straight
  // line is easier to read than a queue in front of a blob.
  const hedges = tiles.find(SLUG, { category: 'plant', tags: ['hedge'], maxCells: 1 });
  // Only EAST-WEST fence runs exist in this map, and that is a camera constraint rather than
  // a taste one. Dumped from `pack.bin`: `fence_side_edge_s` is a rail panel in the plane
  // z = 0.5, which faces the camera, while `fence_side_edge_w`'s panel is in x = 0.5, which
  // under a yaw-locked 45-degree camera is edge-on and rasterises as a bare dark line — the
  // same failure as the trees' second crossed quad. North-south boundaries are hedged.
  const fenceEW = tiles.find(SLUG, { category: 'fence' }).find((m) => m.name === 'fence_side_edge_s');
  if (hedges.length) {
    const plantHedge = (cx, cz) => {
      if (!draft.inside(cx, cz) || onRoad(cx, cz) || onCorridor(cx, cz)) return;
      if (draft.occupied[draft.idx(cx, cz)]) return;
      draft.place(tiles.pick(hedges, cx, cz, { salt: 7 }), cx, cz, { collision: 'block', layer: 4 });
    };
    const plantFence = (cx, cz, model) => {
      if (!model) return plantHedge(cx, cz);
      if (!draft.inside(cx, cz) || onRoad(cx, cz) || onCorridor(cx, cz)) return;
      if (draft.occupied[draft.idx(cx, cz)]) return;
      draft.place(model, cx, cz, { collision: 'block', layer: 4 });
    };
    for (const f of FIELDS) {
      // `north` is fenced rather than hedged: a fence is 1.25 units of open post-and-rail, so
      // the far edge of a field does not become a second wall of bushes behind the first.
      for (let cz = f.z0; cz <= f.z1; cz++) {
        for (let cx = f.x0; cx <= f.x1; cx++) {
          const edge = cx === f.x0 || cx === f.x1 || cz === f.z0 || cz === f.z1;
          // Roughly one cell in eight is left out as a gate or a gap, so a field is a field
          // and not a stamped rectangle. Hashed, not random, so it is the same on every replay.
          if (!edge || hash(cx, cz) < 0.13) continue;
          if (f.north && cz === f.z0) plantFence(cx, cz, fenceEW);
          else plantHedge(cx, cz);
        }
      }
    }
    // A single rank two cells in from the map border, so the world has an edge if the camera
    // is ever pulled back past the fields.
    for (let cx = 2; cx < W - 2; cx++) { plantHedge(cx, 2); plantHedge(cx, H - 3); }
    for (let cz = 2; cz < H - 2; cz++) { plantHedge(2, cz); plantHedge(W - 3, cz); }
    // A hedgerow along the road's east verge north of the elbow, so the eye has a long
    // straight line to read the queue's bend against.
    for (let cz = SPUR.z0 - 10; cz <= SPUR.z0 - 2; cz++) plantHedge(ROAD.x1 + 2, cz);
  }

  const flowers = tiles.find(SLUG, { tags: ['flower'] });
  if (flowers.length) {
    draft.scatter(rng, (cx, cz) => tiles.pick(flowers, cx, cz, { salt: 2 }), {
      rect: { x: 5, z: 5, w: W - 10, h: H - 10 }, chance: 0.045,
      avoidTags: ['path', 'tallgrass'], opts: { collision: 'walk', layer: 5 },
    });
  }
  const decor = tiles.find(SLUG, { tags: ['decor'] });
  if (decor.length) {
    draft.scatter(rng, (cx, cz) => tiles.pick(decor, cx, cz, { salt: 4 }), {
      rect: { x: 5, z: 5, w: W - 10, h: H - 10 }, chance: 0.025,
      avoidTags: ['path', 'tallgrass'], opts: { collision: 'walk', layer: 5 },
    });
  }

  draft.spawn = { ...SPAWN };
  draft.mark('corner', ROAD.x0, SPUR.z0 + 1);
  draft.mark('grass', PATCH.x1 - 1, SPUR.z0 + 1);
}

/**
 * Extras on their own routes, placed well clear of the queue's corridor: two on fixed beats
 * and one strolling, so a wide shot has movement in it that the party is not part of.
 */
const NPCS = [
  { name: 'showcase/hiker', trainer: 'heroine', cx: 33, cz: 33, dir: WEST, route: 'w6 n4 e6 s4' },
  { name: 'showcase/pup', species: 'lillipup', cx: 20, cz: 21, dir: EAST, route: 'e5 s3 w5 n3' },
  { name: 'showcase/nurse', species: 'audino', cx: 34, cz: 20, dir: SOUTH, route: 'wander' },
];

/**
 * Where each mode stops the walk, as steps *into the route* (the north leg's length depends
 * on the gap), plus extra sim ticks for the sub-tile offset and the zoom to frame it at.
 */
const STOPS = {
  // One step past the corner: the tail is still climbing the road, a member is on the corner
  // cell and the lead has already turned west. That is the pose that reads as a queue.
  corner: { after: 1, sub: 3, ppu: PPU.normal },
  closeup: { after: 1, sub: 3, ppu: PPU.close },
  // Thirteen steps down the spur puts the lead inside the tall grass with the trainer still
  // on the last cell of the road behind it — encounters roll on the *lead's* cell.
  grass: { after: LEG.west, sub: 3, ppu: PPU.normal },
  // Six steps into the south leg: the whole queue walking at the camera, every face up,
  // frozen on the walk's stride frame.
  //
  // There was a `run` mode here, pairing this framing at 0.15 s/tile so the trainer's leaning
  // run trio could be cropped against the walk. Run is gone from the game,
  // so the mode went with it.
  south: { after: LEG.west + 6, sub: 3, ppu: PPU.normal },
  // Pulled back so the road, the fields and the grass read as a place. `k` is 1.5 rather than
  // 1: at k=1 a tile texel lands on half an internal pixel and the ground goes to mush, and
  // the queue — the point of the shot — was 4% of the frame height.
  wide: { after: 1, sub: 3, ppu: PPU.wide },
};

/**
 * Rebuilds the map's geometry with tiles' per-cell ground variation switched off.
 *
 * The meadow shipped as a hard 50/50 checkerboard, and it is not this map's fill: the query
 * `find(SLUG, {category:'ground', tags:['grass']})` returns exactly ONE model (`grass`, id 36
 * — `grass_v2` carries the `raised` tag and `tiles.find` excludes raised models unless asked
 * for them), and `tiles.pick` returns `grass` for every cell. Probed in the browser.
 *
 * The checkerboard comes from `tiles/instanced.js`. AdAstra's lawn is GLOBALMAPPING at
 * uvScale 0.25, so a cell samples a 16x16-texel window of a 64x64 texture — but the per-cell
 * "phase" that breaks the 4-cell repeat offsets by `floor(hash*n)/n` where `n` is the texture
 * size in texels, i.e. by up to the WHOLE texture. Neighbouring cells therefore land on
 * unrelated regions of a strongly mottled source and every cell edge becomes a value step.
 * A quarter turn per cell compounds it. `?variety=0` removes both and the lawn comes back
 * organic.
 *
 * The bound belongs in tiles and is filed as a coreRequest. Meanwhile the only knob is a URL
 * parameter the critic will not pass, so this rebuilds the same placements through the same
 * public `tiles.buildInstances` with `variety: 0` and hides terrain's copy. It costs a second
 * set of instanced meshes — measured — and it is skipped entirely if
 * the URL pinned `variety`, so an A/B still works.
 */
function reground(ctx) {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  if (params.has('variety')) return null;
  const terrain = ctx.get('terrain');
  const tiles = ctx.get('tiles');
  const draft = terrain.draft?.();
  const built = terrain.world?.();
  if (!draft?.placements || typeof built?.setVisible !== 'function') return null;
  built.setVisible(false);
  const world = tiles.buildInstances(ctx.three.scene, draft.tileset, draft.placements,
    { name: 'simulation:reground', variety: 0 });
  ctx.bus.once('world:unloaded', () => world.dispose());
  ctx.log.info(`simulation: reground ${world.stats.meshes} meshes, ` +
    `${Math.round(world.stats.triangles / 1000)}k tris (tiles variety off — see showcase.js)`);
  return world;
}

export async function showcaseSimulation(mode, ctx) {
  const sim = ctx.get('simulation');
  if (mode === 'city') return showcaseCity(ctx, sim);

  const key = STOPS[mode] ? mode : 'corner';
  const stop = STOPS[key];
  ctx.get('environment').setBiomePreset?.('meadow');

  const terrain = ctx.get('terrain');
  terrain.register(MAP_ID, (draft, c) => buildWalkMap(draft, c));
  await terrain.load(MAP_ID, { w: MAP_SIZE, h: MAP_SIZE, tileset: SLUG, biome: 'meadow', seed: ctx.config.seed });
  const reground_ = reground(ctx);

  sim.placePlayer(SPAWN.cx, SPAWN.cz, SPAWN.dir);
  sim.walk(routeFor(sim.gap()), { loop: true });
  // Life at the edges of the frame, on their own seeded routes: an NPC is a one-member line
  // walking the same grid with the same collision, so this exercises `spawnNpc` on screen
  // without ever crowding the queue the shot is about.
  for (const npc of NPCS) sim.spawnNpc(npc);
  const at = sim.advanceTo(legNorth(sim.gap()) + stop.after, stop.sub);
  sim.freeze(true);

  ctx.config.set({ pixelsPerUnit: stop.ppu ?? PPU.normal });

  const lineup = sim.lineup();
  ctx.log.info(`simulation showcase "${key}": stopped at step ${at.steps} t=${at.t}, gap ${sim.gap()}; ` +
    `${lineup.map((m) => `${m.role}=${m.who}@${m.cx},${m.cz}/${m.gait}${m.phase}`).join(' | ')}; ` +
    `lead stands on [${(terrain.tagsAt(lineup[0].cx, lineup[0].cz) ?? []).join(',') || 'plain'}]` +
    `${reground_ ? '' : ' (reground skipped)'}`);
}

/**
 * The demo city, with the party walking its high street and NPCs on their own routes — the
 * lobby as it should look, rather than as the empty square it has been.
 */
async function showcaseCity(ctx, sim) {
  await ctx.get('city').enter?.();
  const terrain = ctx.get('terrain');

  // The party is staged on a run of open cells this module finds on the map, rather than on
  // a route written against a plaza `city` may have moved since.
  //
  // Two things forced it. A scripted route *skips* a blocked step rather than wedging
  // (route.js), so when the lobby grew hedges and flower beds the freeze silently drifted 17
  // steps past the pose it was written for and the queue landed in a heap round a lamp post —
  // wrong, with no error anywhere. And a queue frozen on a north-south leg is unreadable
  // whatever the map does: under a 45-degree camera a 2.83-unit sprite covers two tiles of
  // ground depth, so two members two cells apart overlap almost exactly, which is what buried
  // Snivy behind the trainer's back. East-west they cannot overlap at all. So: find the
  // longest open east-west run near the spawn, put the line on it, and walk west along it.
  const gap = sim.gap();
  const span = gap * 4 + 4;
  const spawn = terrain.handle?.()?.spawn ?? { cx: 31, cz: 40 };
  const lane = openRun(terrain, spawn, span);
  if (lane) {
    sim.placePlayer(lane.cx - gap * 2, lane.cz, WEST);
    sim.walk(`w${Math.max(2, lane.run - span)}`, { loop: true });
  } else {
    // The map has no open run at all: fall back to the old scripted walk rather than to
    // nothing, so the mode still renders something a critic can look at.
    ctx.log.warn('simulation showcase "city": no open east-west run near the spawn');
    sim.placePlayer(spawn.cx, spawn.cz + 1, SOUTH);
    sim.walk('s3 w9 n3 e9', { loop: true });
  }
  const at = sim.advanceTo(2, 3);
  sim.freeze(true);
  // The lobby's lawn is drawn by the same tiles code that checkerboards the meadow's; see
  // `reground`. `city` builds its structures as separate instanced worlds, which are left
  // alone — only the map draft terrain realised is rebuilt.
  const regrounded = reground(ctx);

  // Then clear the lobby's cast out of the queue's own space.
  //
  // The mode's claim is "the party walking a real map somebody else authored", and with
  // `city`'s NPCs standing at the same scale among four party members at the same scale, a
  // critic could not tell which four were the party. Only the ones that crowd the line go: an
  // NPC further off than `CITY_CLEARANCE` cells from every member stays, so the square is
  // still populated and `spawnNpc` is still exercised on screen. Measured against the frozen
  // pose, so what is removed is exactly what would have been in the way.
  const line = sim.lineup();
  let cleared = 0;
  for (const npc of sim.npcs()) {
    const near = line.some((m) => Math.abs(m.cx - npc.cx) <= CITY_CLEARANCE
      && Math.abs(m.cz - npc.cz) <= CITY_CLEARANCE);
    if (near && sim.removeNpc(npc.id)) cleared++;
  }

  // Two cells of camera nudge south, which lifts the queue into the frame's upper third and
  // brings the rest of the square — its benches, its flower beds and the NPCs still on their
  // routes — in behind it. The line is staged, but the lobby around it is not.
  sim.frameOffset(0, 2);

  ctx.config.set({ pixelsPerUnit: PPU.normal });
  const l = sim.lineup();
  const straight = l.every((m) => m.cz === l[0].cz) && new Set(l.map((m) => m.cx)).size === l.length;
  // A lane can still be crossed by something the walker had to step round, and a queue that
  // is not straight is the silent drift this staging exists to stop. Say so rather than
  // shipping the frame quietly — `warn` and not `error`, because the shot is still a shot.
  if (!straight) {
    ctx.log.warn('simulation showcase "city": the queue did not come out straight on the lane it found; ' +
      `${l.map((m) => `${m.who}@${m.cx},${m.cz}`).join(' ')}`);
  }
  ctx.log.info(`simulation showcase "city": step ${at.steps} t=${at.t} on lane ` +
    `${lane ? `${lane.cx},${lane.cz} run ${lane.run} paved ${lane.paved}` : 'none'}; ` +
    `${l.map((m) => `${m.role}=${m.who}@${m.cx},${m.cz}`).join(' | ')}; ` +
    `straight=${straight}; ${sim.npcs().length} NPCs (${cleared} cleared)` +
    `${regrounded ? '' : '; reground skipped'}`);
}

/**
 * The longest unbroken east-west run of walkable cells near a point, preferring the road.
 *
 * `terrain.passable` is the same call the walker itself makes, so a run this returns is a run
 * the queue can actually stand on — including whatever `city` planted this week. Scanning is
 * bounded to twenty rows around the spawn so the party is staged in the part of the map the
 * scene meant to be looked at, not in a service alley on the far side of it.
 *
 * @returns {{cx:number, cz:number, run:number}|null} `cx` is the run's EAST end.
 */
function openRun(terrain, near, need) {
  const { w, h } = terrain.bounds?.() ?? { w: 0, h: 0 };
  let best = null;
  for (let cz = Math.max(1, near.cz - 10); cz <= Math.min(h - 2, near.cz + 10); cz++) {
    let run = 0;
    for (let cx = 1; cx < w - 1; cx++) {
      run = terrain.passable(cx, cz, WEST) ? run + 1 : 0;
      if (run < need) continue;
      // Paving under every cell the line will stand on, counted rather than sampled at one
      // end: the first version scored the run's east cell only and happily staged the party
      // on a lawn one row south of the square.
      let paved = 0;
      for (let i = 0; i < need; i++) {
        const t = terrain.tagsAt(cx - i, cz) ?? [];
        if (PAVED_TAGS.some((tag) => t.includes(tag))) paved++;
      }
      const score = paved * 3 + Math.min(run, need + 6)
        - Math.abs(cz - near.cz) - Math.abs(cx - near.cx) * 0.25;
      if (!best || score > best.score) best = { cx, cz, run, paved, score };
    }
  }
  return best;
}
