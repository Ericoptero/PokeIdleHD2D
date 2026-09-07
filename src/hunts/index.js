/**
 * hunts — the biome maps (ARCHITECTURE §5.14). SEED: forest, cave, coast, meadow.
 * The `hunts` builder owns the composition of each.
 */
import { BIOMES, buildHuntMap } from './maps.js';

export default {
  id: 'hunts',
  needs: ['terrain', 'encounter', 'environment'],

  init(ctx) {
    const terrain = ctx.get('terrain');
    for (const b of BIOMES) terrain.register(`hunt-${b.id}`, (draft, c) => buildHuntMap(b, draft, c));

    return {
      list: () => BIOMES.map((b) => ({ id: b.id, name: b.name, preset: b.preset })),
      async enter(id = 'forest') {
        const biome = BIOMES.find((b) => b.id === id) ?? BIOMES[0];
        ctx.get('environment').setBiomePreset?.(biome.preset);
        const handle = await terrain.load(`hunt-${biome.id}`, {
          w: biome.size, h: biome.size, tileset: 'bw2-adastra', biome: biome.id, seed: ctx.config.seed,
        });
        const spawn = handle?.spawn ?? { cx: 8, cz: 8 };
        ctx.three.rig.setFocus(spawn.cx + 0.5, terrain.height(spawn.cx, spawn.cz), spawn.cz + 0.5, true);
        ctx.get('simulation').placePlayer?.(spawn.cx, spawn.cz, spawn.dir ?? 0);
        return handle;
      },
      preset(name) {
        const d = terrain.draft();
        const m = d?.marker(name);
        if (!m) return false;
        ctx.three.rig.setFocus(m.cx + 0.5, d.heightAt(m.cx, m.cz), m.cz + 0.5, true);
        return true;
      },
    };
  },

  async showcase(mode, ctx) {
    await ctx.get('hunts').enter(mode && mode !== 'default' ? mode : 'forest');
  },
};
