/**
 * The two worlds the terrain draft cannot carry, plus the lights.
 *
 * A `Placement` is `{ modelId, cx, cz, … }` and `tiles.buildInstances()` resolves that id
 * against **one** tileset, so a Pokemon Center (id 2 of `structures`) put through the
 * AdAstra draft would draw AdAstra's model 2 — a path corner — and the building would
 * simply never appear. So the authored buildings and the adapted props get their own
 * `InstancedWorld` each, built from the same `layout.js` the map reserved its cells from.
 * Two extra worlds cost about twenty draw calls between them, against a budget of 1500.
 *
 * Lights live here too, because a lamp post and its bulb have to be placed from the same
 * numbers or the glow floats off the lamp.
 */

import {
  PLOTS, PROPS, LAMPS, WINDOW_GLOWS, PLAZA_STONE, PAVING, bulbOf, plotModel,
} from './layout.js';
import { repaint } from './recolor.js';

/**
 * The Mart is blue. Six buildings drawn from one `roof.png` is a red-roof monoculture, and
 * the two shops in particular were indistinguishable at the default framing — same roof,
 * same wall, same striped awning, same emblem. `poke_mart:*` are the Mart's *own* materials
 * in the pack (the structure builder emits one set per building even where the image file is
 * shared), so rotating their hue touches the Mart and nothing else. See `recolor.js`.
 *
 * The cottages take a smaller turn towards ochre, which is enough to stop four identical
 * houses reading as one terrace without inventing a second architecture for them.
 */
const REPAINT = {
  'poke_mart:roof': { hue: 208, sat: 0.86, light: 1.0 },
  'poke_mart:awning': { hue: 208, sat: 0.80, light: 1.0 },
  'poke_mart:sign': { hue: 208, sat: 0.90, light: 1.0 },
  'house_a:roof': { hue: 22, sat: 0.72, light: 0.95 },
};

/** The registry hands out a null-object proxy for a dead module, and it answers
 *  `typeof api.foo === 'function'` with true. `__missing` is the only honest tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * Takes the roofs *out of the shadow receiver set*, and this is a workaround, not a fix.
 *
 * Every building carried a hard-edged black wedge across its roof at every hour with the sun
 * above the horizon, and the discriminating fact is that the wedge sat on the **same west
 * facet at 08:00, with the sun in the east, and at 17:30 with it in the west**
 * (`docs/progress/city/critic/m08-plaza.png` against `g175-plaza.png`). A real hipped-roof
 * terminator swaps sides when the sun crosses the ridge; one that does not is not shading,
 * it is the roof shadow-mapping *itself* — `shadowBias -0.0006` / `shadowNormalBias 0.035`
 * are not enough for a 45-degree facet at `shadowExtent 56`, and the facet's own depth wins
 * against its own shadow-map texel.
 *
 * Nothing in this town casts onto a roof: the roofs are the tallest things on the map and
 * the tree line stands two ranks away from every plot. So refusing the shadow costs the
 * scene nothing and removes the single most visible artifact in the module. The real fix is
 * `core/render.js`'s bias against a cascade this size, and it is filed as a coreRequest.
 *
 * @returns {number} how many meshes were taken out
 */
function unshadowRoofs(tileset, world) {
  const mats = tileset?.pack?.materials;
  if (!mats || !world?.meshes) return 0;
  let n = 0;
  for (const { mesh, model, groupIndex } of world.meshes) {
    const id = model?.groups?.[groupIndex]?.materialId;
    const name = id === undefined ? '' : (mats[id]?.name ?? '');
    if (!/:(roof|awning)$/.test(name)) continue;
    mesh.receiveShadow = false;
    n++;
  }
  return n;
}


/**
 * Builds the structure and prop worlds and registers every practical light.
 *
 * @param {object} ctx  core context
 * @returns {Promise<{dispose:() => void, stats:object}>}
 */
export async function dressCity(ctx) {
  const tiles = ctx.get('tiles');
  const { log } = ctx;
  const scene = ctx.three.scene;
  const worlds = [];
  const stats = { structures: 0, props: 0, paving: 0, lamps: 0, glows: 0, meshes: 0, triangles: 0 };
  /** @type {(() => void)|null} */
  let undoRepaint = null;

  // --- the authored buildings ----------------------------------------------
  const structures = await tiles.load('structures').catch((err) => {
    log.warn('city: the `structures` tileset did not load — the town has no buildings', err);
    return null;
  });
  if (structures) {
    const placements = [];
    for (const plot of PLOTS) {
      const model = plotModel(tiles, plot);
      if (!model) { log.warn(`city: no structure of kind "${plot.kind}"`); continue; }
      placements.push({ modelId: model.id, cx: plot.x, cz: plot.z, y: 0, rot: 0 });
    }
    if (placements.length) {
      undoRepaint = repaint(tiles.get('structures'), REPAINT, log);
      // `variety` off: a quarter turn or a texture phase shift is meaningful on a square of
      // lawn and nonsense on a building with a front door.
      const world = tiles.buildInstances(scene, 'structures', placements,
        { name: 'city:structures', variety: 0 });
      worlds.push(world);
      stats.structures = placements.length;
      stats.meshes += world.stats.meshes;
      stats.triangles += world.stats.triangles;
      stats.roofsUnshadowed = unshadowRoofs(tiles.get('structures'), world);
    }
  }

  // --- the adapted props ----------------------------------------------------
  const props = await tiles.load('props').catch((err) => {
    log.warn('city: the `props` tileset did not load — the town is undressed', err);
    return null;
  });
  if (props) {
    const placements = [];
    for (const p of PROPS) {
      const model = tiles.byName('props', p.model);
      if (!model) { log.warn(`city: no prop named "${p.model}"`); continue; }
      placements.push({ modelId: model.id, cx: p.cx, cz: p.cz, y: p.y ?? 0, rot: p.rot ?? 0 });
    }
    if (placements.length) {
      const world = tiles.buildInstances(scene, 'props', placements,
        { name: 'city:props', variety: 0 });
      worlds.push(world);
      stats.props = placements.length;
      stats.meshes += world.stats.meshes;
      stats.triangles += world.stats.triangles;
    }
  }

  // --- the square's paving --------------------------------------------------
  // AdAstra has no stone (see `PAVING`), so the square is laid from `pt-overworld-7`'s
  // `set21` — and, like the buildings, a second tileset means a third instanced world.
  // Solved with `outsideIsFilled` **true**, i.e. centre slots everywhere. The palette's
  // twelve border slots were tried first (`docs/progress/city/r2/02-plaza.png`) and they
  // carry a bright green grass fringe, so the square came out ringed in a scalloped green
  // ribbon and read as a bowling green. The square's border course is the gravel rim
  // `PLAZA_STONE` is already inset from — `03-plaza-noedge.png` is the A/B.
  const paving = await tiles.load(PAVING.tileset).catch((err) => {
    log.warn(`city: "${PAVING.tileset}" did not load — the square keeps its dirt`, err);
    return null;
  });
  if (paving) {
    const { x, z, w, h } = PLAZA_STONE;
    const occ = new Uint8Array(w * h).fill(1);
    const solved = tiles.autotile.solvePlacements(PAVING.tileset, PAVING.set, occ, w, h,
      { outsideIsFilled: PAVING.edged !== true });
    if (!solved.length) {
      log.warn(`city: auto-tile set "${PAVING.set}" resolved no paving in "${PAVING.tileset}"`);
    } else {
      const world = tiles.buildInstances(scene, PAVING.tileset,
        solved.map((p) => ({ modelId: p.modelId, cx: x + p.cx, cz: z + p.cz, y: PAVING.y, rot: 0 })),
        { name: 'city:paving', variety: 0, castShadow: false });
      worlds.push(world);
      stats.paving = solved.length;
      stats.meshes += world.stats.meshes;
      stats.triangles += world.stats.triangles;
    }
  }

  // --- practical lights -----------------------------------------------------
  // `environment` owns the night ramp and the point-light pool (ARCHITECTURE §5.3); the city
  // only says where the bulbs are. Registering here rather than making our own PointLights
  // is what keeps the lamps off at noon and on at dusk without the city knowing the hour.
  const env = ctx.get('environment');
  if (isLive(env) && env.lamps && typeof env.lamps.add === 'function') {
    env.lamps.clear();

    for (const lamp of LAMPS) {
      const model = tiles.find('bw2-adastra', { category: 'light', orientation: lamp.head })[0];
      const b = bulbOf(model, lamp.cx, lamp.cz);
      env.lamps.add({
        x: b.x, y: b.y, z: b.z,
        // Sodium, not tungsten: the reference stills read distinctly orange against the
        // blue of the night sky, and that contrast is most of what sells "night".
        //
        // A *pool*, and the two numbers pull against each other. `radius` is the
        // PointLight's cutoff and the bulb hangs at y 3.3; at 16 one lamp reaches most of a
        // twenty-cell square, so six of them wash the whole plaza to an even grey and there
        // is no pool anywhere — which is the same complaint as "too weak", from the other
        // side. 12 lands the edge about nine cells out, so four lamps across the square read
        // as four overlapping circles with darker paving between them, which is what
        // `docs/refs/03` has. `intensity` then carries the brightness the reach gave up.
        //
        // `size` is the glow quad, and it is deliberately *large* against that intensity.
        // The quad's core (`pow(1-2.6r,3) * 3.2`) clips to white at any intensity worth
        // having, so the sodium colour lives entirely in the halo (`pow(1-r,2.6) * 0.55`) —
        // and the halo is only as wide as the quad. A small quad is a white dot; a wide one
        // is a white filament inside an orange glare, which is what a sodium lamp is.
        color: 0xffb166, intensity: 2.0, radius: 12, size: 0.85,
      });
      stats.lamps++;
    }

    if (structures) {
      for (const plot of PLOTS) {
        for (const g of WINDOW_GLOWS[plot.kind] ?? []) {
          env.lamps.add({
            x: plot.x + g.x, y: g.y, z: plot.z + g.z,
            color: g.color, intensity: g.intensity, radius: g.radius, size: g.size,
          });
          stats.glows++;
        }
      }
    }
  }

  log.info(`city dressing: ${stats.structures} buildings, ${stats.props} props, ` +
    `${stats.paving} paving, ${stats.lamps} lamps + ${stats.glows} lit windows, ` +
    `${stats.meshes} meshes, ${Math.round(stats.triangles / 1000)}k tris`);

  return {
    stats,
    dispose() {
      for (const w of worlds) w.dispose();
      worlds.length = 0;
      undoRepaint?.();
      undoRepaint = null;
      const e = ctx.get('environment');
      if (isLive(e) && e.lamps && typeof e.lamps.clear === 'function') e.lamps.clear();
    },
  };
}
