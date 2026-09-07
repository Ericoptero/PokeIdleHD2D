/**
 * Hunt biome authors. Each one is a composed place, not noise: a forest has a clearing and
 * a path through it, a coast has a beach that actually meets the sea, a cave has walls that
 * enclose. SEED — the `hunts` builder deepens each of these.
 */

import { makeRng } from '../core/rng.js';
import { noise2 } from '../core/rng.js';

export const BIOMES = [
  { id: 'forest', name: 'Verdant Wood', preset: 'forest', size: 56 },
  { id: 'meadow', name: 'Sunlit Meadow', preset: 'meadow', size: 56 },
  { id: 'coast', name: 'Saltspray Coast', preset: 'coast', size: 56 },
  { id: 'cave', name: 'Hollow Deep', preset: 'cave', size: 48 },
];

export async function buildHuntMap(biome, draft, ctx) {
  const tiles = ctx.get('tiles');
  const slug = draft.tileset;
  await tiles.load(slug);
  const rng = makeRng(draft.seed, `hunt/${biome.id}`);
  const byName = (n) => tiles.find(slug, { name: n })[0] ?? null;
  const W = draft.w, H = draft.h;

  const grass = tiles.find(slug, { category: 'ground', tags: ['grass'] });
  const ground = grass.length ? grass : tiles.find(slug, { category: 'ground' });
  draft.fill({ x: 0, z: 0, w: W, h: H },
    () => ground[Math.floor(rng.next() * ground.length)], { collision: 'walk' });

  // A winding path is what turns a field into somewhere you walk.
  const pathCentre = (cz) => Math.round(W / 2 + Math.sin(cz * 0.16) * 7 + Math.sin(cz * 0.041) * 4);
  const onPath = (cx, cz) => Math.abs(cx - pathCentre(cz)) <= 1;
  draft.autotile(tiles, 'set0', onPath, { collision: 'walk', layer: 1, outsideIsFilled: false });

  if (biome.id === 'coast') {
    const seaFrom = Math.floor(H * 0.62);
    const shoreline = (cx) => seaFrom + Math.round(Math.sin(cx * 0.19) * 2.5);
    draft.autotile(tiles, 'set7', (cx, cz) => cz > shoreline(cx),
      { collision: 'water', layer: 2, outsideIsFilled: false });
    draft.mark('shore', W >> 1, seaFrom - 3);
    draft.mark('sea', W >> 1, Math.min(H - 3, seaFrom + 6));
  }

  if (biome.id === 'forest' || biome.id === 'meadow') {
    const pond = { cx: Math.floor(W * 0.72), cz: Math.floor(H * 0.3), rx: 5, rz: 4 };
    draft.autotile(tiles, 'set1', (cx, cz) => {
      const dx = (cx - pond.cx) / pond.rx, dz = (cz - pond.cz) / pond.rz;
      return dx * dx + dz * dz < 1;
    }, { collision: 'water', layer: 2, outsideIsFilled: false });
    draft.mark('pond', pond.cx, pond.cz + 6);
  }

  if (biome.id === 'cave') {
    // Cliff walls close the space; the walkable area is what the noise leaves behind.
    draft.autotile(tiles, 'set6', (cx, cz) => {
      const edge = cx < 3 || cz < 3 || cx > W - 4 || cz > H - 4;
      const blob = noise2(cx >> 2, cz >> 2, draft.seed) > 0.62 && !onPath(cx, cz);
      return edge || blob;
    }, { collision: 'block', layer: 3, outsideIsFilled: true });
    draft.mark('chamber', W >> 1, H >> 1);
  } else {
    // Tree density falls off away from the map edge, so the middle stays open.
    const trees = tiles.find(slug, { category: 'tree' }).filter((m) => m.w <= 3);
    const density = biome.id === 'forest' ? 0.34 : 0.06;
    if (trees.length) {
      for (let cz = 1; cz < H - 2; cz++) {
        for (let cx = 1; cx < W - 2; cx++) {
          if (onPath(cx, cz) || draft.occupied[draft.idx(cx, cz)]) continue;
          if (draft.collisionAt(cx, cz) === 'water') continue;
          const edgeBias = 1 - Math.min(1, Math.min(cx, cz, W - cx, H - cz) / 10);
          if (rng.next() > density + edgeBias * 0.4) continue;
          draft.place(trees[Math.floor(rng.next() * trees.length)], cx, cz,
            { collision: 'block', layer: 3 });
        }
      }
    }
  }

  // Tall grass along the path shoulders: encounters where the player actually walks.
  const tall = byName('tall_grass') ?? byName('grass_patch');
  if (tall) {
    for (let cz = 4; cz < H - 4; cz++) {
      for (const cx of [pathCentre(cz) - 3, pathCentre(cz) + 3]) {
        if (cx < 1 || cx > W - 2 || draft.occupied[draft.idx(cx, cz)]) continue;
        if (draft.collisionAt(cx, cz) !== 'walk') continue;
        if (rng.next() < 0.55) draft.place(tall, cx, cz, { collision: 'walk', layer: 5, tags: ['tallgrass', 'encounter'] });
      }
    }
  }

  const decor = tiles.find(slug, { tags: ['decor'] });
  if (decor.length) {
    draft.scatter(rng, () => decor[Math.floor(rng.next() * decor.length)],
      { rect: { x: 3, z: 3, w: W - 6, h: H - 6 }, chance: 0.04, opts: { collision: 'walk', layer: 5 } });
  }

  draft.spawn = { cx: pathCentre(6), cz: 6, dir: 0 };
  draft.mark('entrance', draft.spawn.cx, draft.spawn.cz + 3);
  draft.mark('clearing', W >> 1, H >> 1);
  draft.mark('deep', pathCentre(H - 10), H - 10);
}
