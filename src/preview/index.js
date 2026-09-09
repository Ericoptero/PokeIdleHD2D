/**
 * preview — a neutral asset viewer (integrator-owned).
 *
 * Stages the models of any generated tileset in a labelled grid so an agent can look at raw
 * art without going through a gameplay scene. This exists because "screenshot it and look at
 * it" is the project's only accepted evidence (ARCHITECTURE §8), and an artist working on,
 * say, the Pokemon Center should not have to wait for the city module to place it.
 *
 *   /?showcase=preview&mode=<tileset-slug>[&filter=building][&cols=6][&pad=2]
 *
 * `mode` is the tileset slug under public/generated/tiles/. `filter` matches a category or
 * a tag. Models are laid out on a checkerboard ground with a fixed gap so silhouettes,
 * footprints and heights are directly comparable.
 */

import * as THREE from 'three';

export default {
  id: 'preview',
  needs: ['tiles'],
  showcaseNeeds: ['tiles'],

  init(ctx) {
    let group = null;
    let staged = [];

    return {
      staged: () => staged.slice(),
      clear() { group?.dispose?.(); group = null; staged = []; },

      /**
       * @param {string} slug      tileset to show
       * @param {{filter?:string, cols?:number, pad?:number}} [opts]
       */
      async show(slug, opts = {}) {
        const tiles = ctx.get('tiles');
        const ts = await tiles.load(slug);
        if (!ts) throw new Error(`preview: tileset "${slug}" did not load`);

        const filter = opts.filter ?? null;
        const models = tiles.models(slug).filter((m) =>
          !filter || m.category === filter || m.tags.includes(filter));
        if (!models.length) throw new Error(`preview: "${slug}" has no models matching "${filter}"`);

        // Widest model decides the pitch, so nothing overlaps its neighbour.
        const pad = opts.pad ?? 2;
        const pitchX = Math.max(...models.map((m) => m.w ?? 1)) + pad;
        const pitchZ = Math.max(...models.map((m) => m.h ?? 1)) + pad;
        const cols = opts.cols ?? Math.ceil(Math.sqrt(models.length * (pitchZ / pitchX)));
        const rows = Math.ceil(models.length / cols);

        // A checkerboard floor gives scale and shows contact shadows honestly.
        const floorW = cols * pitchX + pad * 2;
        const floorH = rows * pitchZ + pad * 2;
        const check = makeCheckerTexture(THREE);
        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(floorW, floorH),
          new THREE.MeshLambertMaterial({ map: check }),
        );
        check.repeat.set(floorW / 2, floorH / 2);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(floorW / 2 - pad, 0, floorH / 2 - pad);
        floor.receiveShadow = true;
        floor.name = 'preview:floor';
        ctx.three.scene.add(floor);

        const placements = models.map((m, i) => ({
          modelId: m.id,
          cx: (i % cols) * pitchX,
          cz: Math.floor(i / cols) * pitchZ,
          y: 0, rot: 0, tint: 0xffffff,
        }));
        group = tiles.buildInstances(ctx.three.scene, slug, placements, { name: `preview:${slug}` });
        staged = models.map((m, i) => ({ ...m, at: [placements[i].cx, placements[i].cz] }));

        // The widest rung that still holds the whole sheet of models. Zoom is a three-rung
        // ladder now, not a solved-for distance (DECISIONS #60), so this fits rather than fills.
        ctx.three.rig.frame(floorW / 2 - pad, floorH / 2 - pad, 0,
          { ppu: ctx.three.rig.fitFraming(floorW, floorH).ppu });
        ctx.log.info(`preview "${slug}": ${models.length} models, ${cols}x${rows}, ` +
          `${group.stats.meshes} meshes, ${Math.round(group.stats.triangles / 1000)}k tris`);
        return { models: models.length, cols, rows, floorW, floorH };
      },

      /** Frames one named model so a critic can judge it close up. */
      focusModel(name) {
        const m = staged.find((s) => s.name === name);
        if (!m) return false;
        ctx.three.rig.frame(m.at[0] + (m.w ?? 1) / 2, m.at[1] + (m.h ?? 1) / 2, 0,
          { ppu: ctx.three.rig.PPU.close });
        return true;
      },

      preset(name) { return this.focusModel(name); },
    };
  },

  async showcase(mode, ctx) {
    const params = new URLSearchParams(location.search);
    const slug = (mode && mode !== 'default') ? mode : (params.get('set') ?? 'bw2-adastra');
    await ctx.get('preview').show(slug, {
      filter: params.get('filter') ?? null,
      cols: params.get('cols') ? Number(params.get('cols')) : undefined,
      pad: params.get('pad') ? Number(params.get('pad')) : undefined,
    });
    const focus = params.get('focus');
    if (focus) ctx.get('preview').focusModel(focus);
  },
};

/** A 2x2 mid-grey checker; keeps the eye honest about scale and shadow contact. */
function makeCheckerTexture(T) {
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = ((x >> 2) + (y >> 2)) & 1;
      const v = on ? 168 : 138;
      const i = (y * size + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v - 6; data[i + 3] = 255;
    }
  }
  const tex = new T.DataTexture(data, size, size, T.RGBAFormat);
  tex.wrapS = tex.wrapT = T.RepeatWrapping;
  tex.magFilter = T.NearestFilter;
  tex.minFilter = T.NearestFilter;
  tex.colorSpace = T.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
