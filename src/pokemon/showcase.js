/**
 * pokemon showcase — the cast, on real ground, at a zoom where the pixels can be judged.
 *
 * Modes (`?showcase=pokemon&mode=…`):
 *   default   a rank of species, one per generation, in all four directions, with the
 *             trainer's four directions and his west walk cycle in front of them.
 *   trainer   the trainer rows close in. This is the shot that settles DECISIONS #17: the
 *             west sprite must face screen-left, and the four walk phases must read as
 *             contact / stride / contact / opposite stride.
 *   depth     sprites in front of, level with and behind a tree line, plus a giant, to show
 *             the depth test against tall tiles and the contact shadows on two surfaces.
 *   dex       forty species at once — the atlas and the instanced mesh still cost two draws.
 *
 * `?cameraDistance=` still wins if it is given, so a critic can zoom without editing code.
 */

import { SOUTH, WEST, NORTH, EAST } from '../core/dir.js';
import { TEXELS_PER_UNIT } from './sprites.js';

const SLUG = 'bw2-adastra';
const DIRS = [SOUTH, WEST, NORTH, EAST];

/** One recognisable starter per generation — a fixed list, so the shot is reproducible. */
const RANK = [
  'pikachu', 'cyndaquil', 'mudkip', 'riolu',
  'oshawott', 'fennekin', 'rowlet', 'sprigatito',
];

/** Big bodies: three of the 61 sheets that ship at 128x256, i.e. 64 px frames. */
const GIANTS = ['steelix', 'lugia', 'dondozo'];

/**
 * Camera distances at which one sprite texel is a whole number of internal pixels.
 *
 * The internal buffer is 640 px wide at 1080p (pixelScale 3), and a perspective camera at
 * `fov` degrees and distance D covers `2·D·tan(fov/2)·aspect` world units, so
 *
 *     internal pixels per world unit = 640 / (2·D·tan(13°)·16/9) = 779.7 / D
 *
 * Sprites carry 16 texels per unit and tiles 32, so D = 779.7/(16·k) puts both on the pixel
 * grid at the focus plane: k = 2 gives 24.36, where one sprite texel is exactly two internal
 * pixels and one tile texel is exactly one. That is the zoom these shots are taken at.
 * (The game's own `config.cameraDistance` default of 30 is not one of these values — see
 * the round-1 report's coreRequest.)
 */
export function pixelExactDistance(k = 2, { fovDeg = 26, internalWidth = 640, aspect = 16 / 9 } = {}) {
  const perUnit = internalWidth / (2 * Math.tan((fovDeg * Math.PI) / 360) * aspect);
  return perUnit / (TEXELS_PER_UNIT * k);
}

/** Frames the scene, unless the URL asked for a distance of its own. */
function frame(ctx, cx, cz, distance) {
  const asked = new URLSearchParams(location.search).has('cameraDistance');
  ctx.three.rig.frame(cx, cz, 0, asked ? ctx.config.cameraDistance : distance);
}

/**
 * A generous field of real tiles. The map is deliberately much larger than the framing so
 * no map edge ever shows: a black wedge of nothing at the horizon would flatter the sprites
 * and hide exactly the ground contact the shot exists to judge.
 */
async function ground(ctx, { w, h, pathBand = null, trees = 0, plants = 0 } = {}) {
  const tiles = ctx.get('tiles');
  const terrain = ctx.get('terrain');
  await tiles.load(SLUG);
  const { MapDraft } = terrain;
  const draft = new MapDraft({ id: 'showcase-pokemon', w, h, tileset: SLUG, biome: 'meadow', seed: ctx.config.seed });

  const grass = tiles.find(SLUG, { category: 'ground', tags: ['grass'] });
  const any = grass.length ? grass : tiles.find(SLUG, { category: 'ground' });
  draft.fill({ x: 0, z: 0, w, h }, (cx, cz) => tiles.pick(any, cx, cz, { salt: 7 }), { collision: 'walk' });

  // A band of path under the front rows, so every contact shadow is judged on two surfaces.
  // Auto-tiled, so the grass/path border is the real 13-case blob and not a butt joint.
  if (pathBand) {
    const placed = draft.autotile(tiles, 'set0',
      (cx, cz) => cz >= pathBand.z && cz < pathBand.z + pathBand.h,
      { collision: 'walk', layer: 1, outsideIsFilled: false });
    if (!placed) {
      // Fall back to the one path model that carries PDSMS global mapping, so a flat band
      // still reads as a road rather than as the same stamp in every square (DECISIONS #8).
      const center = tiles.find(SLUG, { category: 'path' }).filter((m) => m.globalUv)[0];
      if (center) draft.fill({ x: 0, z: pathBand.z, w, h: pathBand.h }, center, { collision: 'walk', layer: 1 });
    }
  }

  if (trees) {
    const models = tiles.find(SLUG, { category: 'tree', maxCells: 4 });
    for (let i = 0; i < trees && models.length; i++) {
      draft.place(models[i % models.length], (trees > 1 ? 5 + i * 4 : 5), 12, { layer: 3 });
    }
  }
  if (plants) {
    const models = tiles.find(SLUG, { category: 'plant' });
    for (let i = 0; i < plants && models.length; i++) {
      draft.place(models[i % models.length], 4 + i * 3, 21, { layer: 2, collision: 'walk' });
    }
  }

  draft.finalize();
  tiles.buildInstances(ctx.three.scene, SLUG, draft.placements, { name: 'showcase:pokemon' });

  // The walkable surface is not always y = 0: AdAstra's grass/path tiles are authored at
  // baseY 0.07 and its dirt at 0.125 (DECISIONS #7). A sprite dropped at 0 sinks its feet
  // into the path and its contact shadow disappears *under* the road, so the staging asks
  // the map how high the ground is, exactly as `simulation` will ask `terrain.height()`.
  const top = new Float32Array(w * h);
  const ts = tiles.get(SLUG);
  for (const p of draft.placements) {
    const model = ts?.byId.get(p.modelId);
    if (!model || !(model.tags ?? []).includes('flat')) continue;
    const y = (p.y ?? 0) + (model.baseY ?? 0);
    for (let dz = 0; dz < (model.h ?? 1); dz++) {
      for (let dx = 0; dx < (model.w ?? 1); dx++) {
        const i = (p.cz + dz) * w + (p.cx + dx);
        if (i >= 0 && i < top.length) top[i] = Math.max(top[i], y);
      }
    }
  }
  draft.surfaceY = (x, z) => {
    const cx = Math.floor(x), cz = Math.floor(z);
    return (cx >= 0 && cz >= 0 && cx < w && cz < h) ? top[cz * w + cx] : 0;
  };
  return draft;
}

/** One row of four: the four directions, or the four phases of one direction's cycle. */
async function row(pokemon, map, { trainer = 'hero', z, cx, gap = 3.0, dirs = null, gait = 'idle', dir = null }) {
  const x0 = cx - (gap * 3) / 2;
  for (let i = 0; i < 4; i++) {
    const x = x0 + i * gap;
    await pokemon.sprites.spawn({
      trainer, gait,
      dir: dirs ? dirs[i] : dir,
      phase: dirs ? 0 : i,
      x, y: map.surfaceY(x, z), z,
    });
  }
}

/**
 * Exercises the §5.5 API in the scene itself. Anything that throws here shows up as a
 * console error in the shot's JSON, which is a budget failure — so the contract is checked
 * on every screenshot instead of only when someone remembers to.
 */
function selfCheck(pokemon, log) {
  const pika = pokemon.species('pikachu');
  const byId = pokemon.species(25);
  const inst = pokemon.createInstance({ species: pika, level: 12, shiny: true, seed: 7 });
  pokemon.addToParty(inst);
  const counts = pokemon.generations().map((g) => `g${g}:${pokemon.byGen(g).length}`).join(' ');
  log.info(`pokemon api: ${pokemon.count()} species (${counts}); ` +
    `species(25)=${byId?.name}; byType('electric')=${pokemon.byType('electric').length}; ` +
    `lead=${pokemon.lead()?.instanceId} shiny=${pokemon.lead()?.shiny}`);
  return pika;
}

export async function showcasePokemon(mode, ctx) {
  const pokemon = ctx.get('pokemon');
  const pika = selfCheck(pokemon, ctx.log);
  ctx.get('environment').setBiomePreset?.('meadow');
  const D2 = pixelExactDistance(2);      // 24.36 — sprite texel = 2 internal pixels
  const D1 = pixelExactDistance(1);      // 48.73 — sprite texel = 1 internal pixel

  if (mode === 'trainer') {
    await pokemon.sprites.prepare([{ trainer: 'hero' }, { trainer: 'heroine' }]);
    const map = await ground(ctx, { w: 40, h: 40, pathBand: { z: 21, h: 4 } });
    // Front to back: the hero's four directions on the path, the heroine's four directions
    // (her east cycle mirrors differently — DECISIONS #17), then the west walk cycle and the
    // west run cycle. Rows are 3.9 tiles apart because a 2.83-unit sprite covers 2.0 tiles of
    // screen height at a 45-degree camera, and anything tighter puts the back row's feet
    // inside the front row's head.
    const cx = 20, gap = 2.9;
    await row(pokemon, map, { trainer: 'hero', z: 22.5, cx, gap, dirs: DIRS });
    await row(pokemon, map, { trainer: 'heroine', z: 18.6, cx, gap, dirs: DIRS });
    await row(pokemon, map, { trainer: 'hero', z: 14.7, cx, gap, dir: WEST, gait: 'walk' });
    await row(pokemon, map, { trainer: 'hero', z: 10.8, cx, gap, dir: WEST, gait: 'run' });
    frame(ctx, cx, 20.0, D2);
    return;
  }

  if (mode === 'depth') {
    await pokemon.sprites.prepare([{ trainer: 'hero' }, { species: GIANTS[0] }, ...RANK.map((species) => ({ species }))]);
    const map = await ground(ctx, { w: 44, h: 40, trees: 9, plants: 13 });
    const at = async (spec) => pokemon.sprites.spawn({ ...spec, y: map.surfaceY(spec.x, spec.z) });
    // One rank behind the tree line and one in front of it, on the same columns: the pair
    // that is occluded and the pair that occludes.
    for (let i = 0; i < 5; i++) {
      await at({ species: RANK[i], dir: SOUTH, x: 9.0 + i * 3.6, z: 9.8 });
      await at({ species: RANK[i + 1], dir: SOUTH, x: 9.0 + i * 3.6, z: 14.0 });
    }
    await at({ trainer: 'hero', dir: NORTH, gait: 'walk', phase: 1, x: 11.5, z: 17.6 });
    await at({ trainer: 'hero', dir: SOUTH, gait: 'run', phase: 1, x: 16.5, z: 19.2 });
    await at({ species: GIANTS[0], dir: SOUTH, x: 22.0, z: 18.4 });
    frame(ctx, 16, 15.5, D2);
    return;
  }

  if (mode === 'dex') {
    const map = await ground(ctx, { w: 72, h: 64 });
    const all = pokemon.baseForms();
    const step = Math.max(1, Math.floor(all.length / 40));
    // One atlas build for the whole cast: preparing sheet by sheet would repack and re-upload
    // the texture forty times over.
    await pokemon.sprites.prepare([
      ...Array.from({ length: 40 }, (_, i) => ({ species: all[(i * step) % all.length] })),
      ...GIANTS.map((species) => ({ species })),
    ]);
    for (let i = 0; i < 40; i++) {
      const s = all[(i * step) % all.length];
      const col = i % 10, row = (i / 10) | 0;
      const x = 18.0 + col * 3.6, z = 26.0 + row * 3.6;
      await pokemon.sprites.spawn({
        species: s, dir: DIRS[row % 4], gait: 'walk', phase: (col + row) & 1,
        x, y: map.surfaceY(x, z), z,
      });
    }
    // The three 64 px sheets, behind the rank: only a wide framing has the headroom for a
    // sprite four world units tall.
    for (let i = 0; i < GIANTS.length; i++) {
      await pokemon.sprites.spawn({ species: GIANTS[i], dir: DIRS[i], x: 24.0 + i * 10, y: map.surfaceY(24.0 + i * 10, 20.0), z: 20.0 });
    }
    ctx.log.info(`pokemon showcase "dex": atlas ${JSON.stringify(pokemon.sprites.stats())}`);
    frame(ctx, 34, 31.5, D1);
    return;
  }

  // --- default -------------------------------------------------------------
  // Rows run away from the camera. Larger z is nearer, so the trainer stands in front and
  // the rank of species recedes: south, west, north, east, then the three giants behind.
  const map = await ground(ctx, { w: 48, h: 44, pathBand: { z: 23, h: 4 } });

  const cx = 20, gap = 2.5, x0 = cx - (gap * (RANK.length - 1)) / 2;
  await row(pokemon, map, { z: 24.0, cx, gap: 2.8, dirs: DIRS });
  await row(pokemon, map, { z: 21.6, cx, gap: 2.8, dir: WEST, gait: 'walk' });

  for (let d = 0; d < DIRS.length; d++) {
    const z = 19.2 - d * 2.4;
    for (let i = 0; i < RANK.length; i++) {
      const x = x0 + i * gap;
      await pokemon.sprites.spawn({
        species: RANK[i], dir: DIRS[d],
        x, y: map.surfaceY(x, z), z,
        gait: 'walk', phase: (i + d) & 1,
      });
    }
  }
  // Normal and shiny of the same species, side by side on the path, so the palette swap is
  // visible and the shiny sheet path is exercised on screen.
  for (let i = 0; i < 2; i++) {
    const x = cx + 6.5 + i * 2.5;
    await pokemon.sprites.spawn({ species: 'pikachu', shiny: i === 1, dir: SOUTH, x, y: map.surfaceY(x, 24.0), z: 24.0 });
  }

  const sprite = await pokemon.sprite(pika, { shiny: true });
  ctx.log.info(`pokemon.sprite(pikachu, shiny): frame ${sprite?.size.frame}px, ` +
    `world ${sprite?.size.world.w.toFixed(2)}x${sprite?.size.world.h.toFixed(2)}, ` +
    `west cycle ${sprite?.frames.west.length} frames`);
  ctx.log.info(`pokemon showcase: ${pokemon.sprites.count()} sprites, atlas ${JSON.stringify(pokemon.sprites.stats())}`);
  frame(ctx, cx, 19.5, D2);
}
