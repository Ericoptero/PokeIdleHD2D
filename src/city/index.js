/**
 * city — the lobby (ARCHITECTURE §5.13).
 *
 * A composed town: grass, an auto-tiled path network, a pond, tree lines, fences, lamps
 * that light at dusk, and the plots the Pokemon Center and Mart stand on. Everything is
 * authored from a seed so the same screenshot can be taken again tomorrow.
 */

import { buildCityMap, CITY_SIZE } from './map.js';

export default {
  id: 'city',
  needs: ['terrain', 'environment'],

  init(ctx) {
    const terrain = ctx.get('terrain');
    terrain.register('demo-city', (draft, c) => buildCityMap(draft, c));

    return {
      async enter() {
        ctx.get('environment').setBiomePreset?.('city');
        const handle = await terrain.load('demo-city', {
          w: CITY_SIZE, h: CITY_SIZE, tileset: 'bw2-adastra', biome: 'city', seed: ctx.config.seed,
        });
        const spawn = handle?.spawn ?? { cx: CITY_SIZE >> 1, cz: CITY_SIZE >> 1 };
        ctx.three.rig.setFocus(spawn.cx + 0.5, terrain.height(spawn.cx, spawn.cz), spawn.cz + 0.5, true);
        ctx.get('simulation').placePlayer?.(spawn.cx, spawn.cz, spawn.dir ?? 0);
        return handle;
      },

      /** Named camera framings the screenshot harness can request. */
      preset(name) {
        const d = terrain.draft();
        if (!d) return false;
        const m = d.marker(name) ?? {
          plaza: d.marker('plaza'),
          center: d.marker('pokecenter-door'),
          mart: d.marker('mart-door'),
          pond: d.marker('pond'),
          gate: d.marker('south-gate'),
        }[name];
        if (!m) return false;
        ctx.three.rig.setFocus(m.cx + 0.5, d.heightAt(m.cx, m.cz), m.cz + 0.5, true);
        return true;
      },

      markers: () => {
        const d = terrain.draft();
        return d ? [...d.markers.keys()] : [];
      },
    };
  },

  async showcase(mode, ctx) {
    await ctx.get('city').enter();
    if (mode && mode !== 'default') ctx.get('city').preset(mode);
  },
};
