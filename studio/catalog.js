/**
 * catalog.js — lazy per-tileset catalog loading, for the asset library and for the
 * catalog-dependent validation checks (`@/terrain/validate.js`'s `env.catalogs`).
 *
 * Never loads all 15 tilesets: the game ships `/generated/tiles/index.json` (the set list)
 * eagerly, and each `catalog.json` only on first use — the biggest one, `hgss-overworld`, is
 * 372 KB / 445 models on its own.
 */

const cache = new Map();

/**
 * The full tileset manifest. `public/generated/tiles/index.json`'s own `built` array is NOT
 * this — it only lists the slugs `npm run assets` most recently rebuilt (three, most of the
 * time), not every tileset the pipeline has ever produced. There is no runtime-discoverable
 * complete manifest (a static host serves no directory listing), so this is the directory
 * enumeration as of this writing, kept here rather than re-derived per session. If the build
 * adds a sixteenth tileset, add its slug here too.
 */
const TILESETS = [
  'bw-overworld', 'bw2-adastra', 'bw2-brom', 'bw2-cave', 'bw2-chargestone', 'bw2-twist',
  'hgss-newbark-houses', 'hgss-overworld', 'hgss-safari', 'props', 'pt-forest',
  'pt-house-indoor', 'pt-overworld-7', 'structures', 'sylvan-town',
];

/** @returns {Promise<{slug:string}[]>} */
export async function listTilesets() {
  return TILESETS.map((slug) => ({ slug }));
}

/** @param {string} slug @returns {Promise<{tileset:string, models:object[], byName:Map, autotileSets:string[]}>} */
export async function loadCatalog(slug) {
  if (cache.has(slug)) return cache.get(slug);
  const promise = fetch(`/generated/tiles/${slug}/catalog.json`)
    .then((r) => { if (!r.ok) throw new Error(`catalog: "${slug}" ${r.status}`); return r.json(); })
    .then((raw) => {
      const byName = new Map(raw.models.map((m) => [m.name, m]));
      const byId = new Map(raw.models.map((m) => [m.id, m]));
      const autotileSets = (raw.autotileSets ?? []).map((s) => s.id ?? s.name);
      return { tileset: slug, raw, models: raw.models, byName, byId, autotileSets };
    });
  cache.set(slug, promise);
  return promise;
}

/** Every loaded catalog, keyed by tileset — the shape `validateMap`'s `env.catalogs` wants. */
export function loadedCatalogs() {
  const out = {};
  for (const [slug, entry] of cache) {
    if (entry instanceof Promise) continue;
    out[slug] = entry;
  }
  return out;
}

/** @param {string} slug @returns {{tileset:string, models:object[], byName:Map, byId:Map, autotileSets:string[]}|null} resolved only */
export function peekCatalog(slug) {
  const entry = cache.get(slug);
  return entry && !(entry instanceof Promise) ? entry : null;
}

/**
 * A deterministic colour for a model, used as its canvas swatch — no thumbnail art exists in
 * the pipeline (`docs/plan`'s own finding), so category + subcategory picks a hue and
 * collision picks how saturated/dark it reads, which is legible and consistent across a
 * whole tileset without loading a single texture.
 */
const CATEGORY_HUE = {
  ground: 96, path: 40, water: 205, shore: 195, tree: 120, plant: 96, fence: 35, bridge: 28,
  cliff: 20, stairs: 260, ledge: 30, prop: 270, light: 45, building: 15, decal: 96, wall: 0, interior: 30, meta: 0,
};
export function colorFor(model) {
  const hue = CATEGORY_HUE[model?.category] ?? 200;
  const sat = model?.collision === 'block' ? 42 : 34;
  const light = model?.collision === 'water' ? 30 : model?.collision === 'block' ? 24 : 30;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// --- real tile previews -----------------------------------------------------------------------
//
// Every `catalog.materials[i]` names a standalone PNG (8×8 to 64×64 — a per-material sheet,
// never a UV atlas, so it is safe to show whole with no cropping). A model is usually
// multi-material (66% of them, measured on bw2-adastra), so `model.materials[0]` is the wrong
// pick a third of the time and, for 15 models, is literally a baked contact-shadow sheet
// (filename contains "kage" — the same discriminator `src/tiles/materials.js`'s `shadowDecal`
// flag already keys on). The pipeline's own rule for "what a tile actually looks like" is the
// dominant group by vertex count (`tools/assets/build-tiles.js` ~L124); this mirrors it.

/** @param {object} model a `catalog.models[i]` entry (carries `groups`/`materials`) @param {object} catalog from `loadCatalog` */
export function dominantMaterialId(model, catalog) {
  const mats = catalog?.raw?.materials ?? [];
  const isShadow = (id) => /kage/i.test(mats[id]?.image ?? '');
  const groups = model?.groups ?? [];
  if (!groups.length) return model?.materials?.[0] ?? null;
  const lit = groups.filter((g) => !isShadow(g.material));
  const pool = lit.length ? lit : groups; // every group a shadow -> fall back to all of them
  return pool.reduce((a, g) => (g.count > a.count ? g : a), pool[0]).material;
}

/** @returns {string|null} the bare PNG filename — the de-dupe/cache key, not the material id. */
export function dominantImage(model, catalog) {
  const id = dominantMaterialId(model, catalog);
  return id != null ? catalog?.raw?.materials?.[id]?.image ?? null : null;
}

/** @returns {string|null} `/generated/tiles/<slug>/tex/<image>` */
export function textureUrlFor(model, catalog) {
  const image = dominantImage(model, catalog);
  return image ? `/generated/tiles/${catalog.tileset}/tex/${image}` : null;
}

// --- species catalog ---------------------------------------------------------------------------
//
// A spawn point's species picker and `@/terrain/validate.js`'s `spawn-point-species` check
// both need to know what a real species name is — the same committed snapshot the game itself
// loads (`src/pokemon/index.js`), fetched once here rather than duplicated.

let speciesPromise = null;

/** @returns {Promise<object[]>} the full species list, `[]` if the snapshot is missing. */
export async function loadSpeciesCatalog() {
  if (!speciesPromise) {
    speciesPromise = fetch('/generated/species.json')
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return speciesPromise;
}

/** Resolved-only peek, for a render loop that cannot await. `null` until loaded. */
let speciesCache = null;
loadSpeciesCatalog().then((list) => { speciesCache = list; });

export function peekSpeciesNames() {
  return speciesCache ? new Set(speciesCache.map((s) => s.name)) : null;
}
