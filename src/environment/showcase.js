/**
 * environment showcase: a plain lit stage — ground, a wall to catch shadows and a few
 * heights — so the critic judges light, sky and grade with nothing else to look at.
 */

export async function showcaseEnvironment(mode, ctx) {
  const tiles = ctx.get('tiles');
  const slug = 'bw2-adastra';
  await tiles.load(slug);
  const { MapDraft } = ctx.get('terrain');
  const draft = new MapDraft({ id: 'showcase-env', w: 44, h: 44, tileset: slug, biome: 'meadow' });
  const grass = tiles.find(slug, { category: 'ground' });
  draft.fill({ x: 0, z: 0, w: 44, h: 44 }, () => grass[0], { collision: 'walk' });
  draft.autotile(tiles, 'set6', (cx, cz) => cz < 6 && cx > 6 && cx < 38,
    { collision: 'block', layer: 2, outsideIsFilled: false });

  const trees = tiles.find(slug, { category: 'tree' }).filter((m) => m.w <= 2);
  for (let i = 0; i < 7; i++) draft.place(trees[i % trees.length], 10 + i * 4, 16, { layer: 3 });
  const lamp = tiles.find(slug, { category: 'light' })[0];
  if (lamp) for (let i = 0; i < 4; i++) draft.place(lamp, 12 + i * 6, 28, { layer: 3 });

  draft.finalize();
  tiles.buildInstances(ctx.three.scene, slug, draft.placements, { name: 'showcase:env' });
  ctx.three.rig.frame(22, 26, 0, 22);
  if (mode && mode !== 'default') ctx.get('environment').preset(mode);
}
