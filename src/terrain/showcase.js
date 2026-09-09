/** terrain showcase: elevation, collision kinds and the authoring API on one map. */
export async function showcaseTerrain(mode, ctx) {
  const terrain = ctx.get('terrain');
  if (!terrain.registered().includes('showcase-terrain')) {
    terrain.register('showcase-terrain', async (draft, c) => {
      const tiles = c.get('tiles');
      await tiles.load(draft.tileset);
      const grass = tiles.find(draft.tileset, { category: 'ground' });
      draft.fill({ x: 0, z: 0, w: draft.w, h: draft.h }, () => grass[0], { collision: 'walk' });
      draft.autotile(tiles, 'set0', (cx) => cx > draft.w / 2 - 3 && cx < draft.w / 2 + 3,
        { collision: 'walk', layer: 1, outsideIsFilled: false });
      draft.autotile(tiles, 'set3', (cx, cz) => cz < 8, { collision: 'block', layer: 2, outsideIsFilled: false });
      draft.autotile(tiles, 'set1', (cx, cz) => cx < 10 && cz > draft.h - 12,
        { collision: 'water', layer: 2, outsideIsFilled: false });
      draft.spawn = { cx: draft.w >> 1, cz: draft.h >> 1, dir: 0 };
      draft.mark('overview', draft.w >> 1, draft.h >> 1);
    });
  }
  await terrain.load('showcase-terrain', { w: 40, h: 40, tileset: 'bw2-adastra', biome: 'meadow' });
  ctx.three.rig.frame(20, 20, 0, { ppu: ctx.three.rig.PPU.normal });
}
