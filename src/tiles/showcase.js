/**
 * tiles showcase: every auto-tile case laid out as a labelled grid, plus a strip of one
 * example per category. This is the scene the tiles critic scores.
 */

export async function showcaseTiles(mode, ctx) {
  const tiles = ctx.get('tiles');
  const slug = 'bw2-adastra';
  await tiles.load(slug);

  const { MapDraft } = ctx.get('terrain');
  const draft = new MapDraft({ id: 'showcase-tiles', w: 72, h: 48, tileset: slug, biome: 'meadow' });
  const grass = tiles.find(slug, { category: 'ground' });
  draft.fill({ x: 0, z: 0, w: draft.w, h: draft.h }, () => grass[0], { collision: 'walk' });

  if (mode === 'catalog') {
    // One of each category, in rows, so a critic can see the whole vocabulary at once.
    const cats = [...new Set(tiles.models(slug).map((m) => m.category))].sort();
    let z = 3;
    for (const cat of cats) {
      const models = tiles.find(slug, { category: cat }).slice(0, 16);
      models.forEach((m, i) => draft.place(m, 3 + i * 4, z, { collision: 'none' }));
      z += 4;
    }
  } else {
    // Every autotile set gets a 9x9 blob plus a one-cell hole, which exercises all 13 cases.
    const sets = tiles.autotile.sets(slug).filter((s) => s.cases >= 12);
    sets.slice(0, 6).forEach((set, i) => {
      const ox = 4 + (i % 3) * 22, oz = 4 + Math.floor(i / 3) * 20;
      draft.autotile(tiles, set.id, (cx, cz) => {
        const inside = cx >= ox && cx < ox + 11 && cz >= oz && cz < oz + 11;
        const hole = cx === ox + 5 && cz === oz + 5;
        const notch = cx >= ox + 8 && cz >= oz + 8;
        return inside && !hole && !notch;
      }, { collision: 'none', layer: 1, outsideIsFilled: false });
    });
  }

  draft.finalize();
  const world = tiles.buildInstances(ctx.three.scene, slug, draft.placements, { name: 'showcase:tiles' });
  ctx.three.rig.frame(draft.w / 2, draft.h / 2 + 6, 0, 34);
  ctx.get('environment').setTimeOfDay?.(ctx.config.tod);
  ctx.log.info(`tiles showcase: ${draft.placements.length} placements, ${world.stats.meshes} meshes`);
}
