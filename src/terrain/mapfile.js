/**
 * mapfile.js — the declarative `.map.json` format and its codec (src/terrain/mapfile.js).
 *
 * A map file is what a `MapDraft` (`./draft.js`) looks like frozen: the four cell-indexed
 * arrays, the placement list split into per-cell "tile" grids and a list of "objects", and
 * every other thing that defines the map — spawn, markers, lights, NPCs, links, camera
 * presets, the patrol loop, per-spawn-point wildlife, and the map's own economy profile.
 * There is exactly one map structure: every map is authored in the Studio and loaded from
 * this file, with nothing left implicit in code (`ARCHITECTURE.md`).
 *
 * Two things this file deliberately does NOT try to do:
 *
 *  - **Recover autotile regions from a finalized draft.** `MapDraft.autotile()` solves a
 *    mask into placements and then forgets the mask — by the time `terrain.load()` hands a
 *    finished draft to `draftToMapFile`, an autotiled path and a hand-placed one look
 *    identical (see `frommap.js`'s header for the replay-order consequence). A `regions[]`
 *    field exists in the schema for the Studio's own paint tools to populate when *authoring*
 *    new autotiled ground, but a snapshot of an existing map never fills it — the baked tiles
 *    round-trip faithfully anyway, as ordinary per-cell placements.
 *  - **Validate anything.** That is `./validate.js`; this file only encodes/decodes.
 *
 * Encoding rules, in order of how much they matter for file size:
 *
 *  1. Cell data (`grid.*`) is palette + run-length encoded, one flat array per grid, in
 *     `draft.idx(cx,cz)` (row-major, `cz*w+cx`) order. A full-map fill is one run.
 *  2. A placement lands in a layer's `tiles[]` grid (four more RLE arrays: model/rot/tint/y)
 *     iff it is the only placement at that (layer, origin cell) AND its model is 1x1 — draft
 *     placements are recorded at their footprint's origin cell only (`MapDraft.place`), so a
 *     multi-cell model is never grid-eligible. Everything else — trees, bridges, anything
 *     sharing a cell — goes in that layer's `objects[]` list.
 *  3. Model references are catalog **names** (`tiles.byName`), not ids — an id is the ordinal
 *     index into `catalog.models` and drifts on every `npm run assets` rebuild. Each layer
 *     keeps the ids it saw at export time as `modelIds`, used only as a diagnostic fallback
 *     when a name fails to resolve (`frommap.js`).
 *  4. A map is rarely one tileset. `MapDraft` only ever builds one `InstancedWorld`, so the
 *     extra tilesets a scene composites on top (buildings, props, dressing) are their own
 *     `layers[]` entries with `role:"extra"`, encoded as an objects-only list (extras are
 *     decorative and routinely multi-cell in practice).
 *
 * **Version 2** retired the `biome` enum (there is no procedural generator left to key off
 * it — every map is authored, not generated) along with the shared `encounters.table`
 * lookup and the loop-derived `wild.resolved.slots` cache. In their place: `economy`, the
 * map's own yield-multiplier profile (`idle/accrual.js` used to key this off a fixed 5-entry
 * `biome` enum; now every map declares its own), and `spawnPoints[]`, where each entry owns
 * its own respawn timer and its own weighted list of species (`src/hunts/index.js`).
 */

const FORMAT = 'pokeidle.map';
const VERSION = 2;
const DEFAULT_TINT = 0xffffff;

/** A map that declares no `economy` block gets this — the neutral profile
 *  `economy/pacing.js` already projects its pricing against. */
export const DEFAULT_ECONOMY = Object.freeze({
  money: 1, exp: 1, research: 1, encounters: 1, favours: Object.freeze({}),
});

/** The environment/lighting preset (`src/environment/presets.js`) a map that names none
 *  falls back to — a plain default, not a "biome": any map may pick any preset. */
export const DEFAULT_ENVIRONMENT_PRESET = 'meadow';

// --- run-length codec, generic over any JSON-serializable per-cell value -------------------

/** Stable key for palette dedup — arrays/objects compare by content, not identity. */
function canon(v) {
  return JSON.stringify(v);
}

/**
 * @param {any[]} values flat, length = w*h, in `cz*w+cx` order
 * @returns {{p: any[], r: [number, number][]}} palette + [paletteIndex, runLength] pairs
 */
export function encodeRuns(values) {
  const index = new Map();
  const p = [];
  const r = [];
  let curIdx = -1;
  let curLen = 0;
  for (const v of values) {
    const k = canon(v);
    let idx = index.get(k);
    if (idx === undefined) {
      idx = p.length;
      p.push(v);
      index.set(k, idx);
    }
    if (idx === curIdx) {
      curLen++;
    } else {
      if (curLen > 0) r.push([curIdx, curLen]);
      curIdx = idx;
      curLen = 1;
    }
  }
  if (curLen > 0) r.push([curIdx, curLen]);
  return { p, r };
}

/**
 * @param {{p: any[], r: [number, number][]}} runs
 * @param {number} length expected total run length; a mismatch throws rather than silently
 *   truncating a map that a bad edit shrank.
 */
export function decodeRuns(runs, length) {
  const { p, r } = runs;
  const out = new Array(length);
  let i = 0;
  for (const [idx, n] of r) {
    const v = p[idx];
    for (let k = 0; k < n; k++) out[i++] = v;
  }
  if (i !== length) {
    throw new Error(`mapfile.decodeRuns: run total ${i} does not match expected length ${length}`);
  }
  return out;
}

const round3 = (v) => (v == null ? v : Math.round(v * 1000) / 1000);

// --- parse / serialize ----------------------------------------------------------------------

/** @param {string|object} input */
export function parseMapFile(input) {
  const map = typeof input === 'string' ? JSON.parse(input) : input;
  if (!map || typeof map !== 'object') throw new Error('mapfile: not an object');
  if (map.format !== FORMAT) throw new Error(`mapfile: unknown format "${map.format}" (expected "${FORMAT}")`);
  if (map.version !== VERSION) throw new Error(`mapfile: unsupported version ${map.version} (expected ${VERSION})`);
  if (!map.id) throw new Error('mapfile: missing "id"');
  if (!(map.w > 0) || !(map.h > 0)) throw new Error('mapfile: missing or invalid "w"/"h"');
  return map;
}

/** True when a JS array's own elements are all primitives or flat arrays of primitives. */
function isFlatArray(v) {
  return Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object'
    || (Array.isArray(x) && x.every((y) => y === null || typeof y !== 'object')));
}

/**
 * A pretty-printer that keeps RLE run/palette arrays on one line and everything else
 * multi-line — a plain `JSON.stringify(x, null, 2)` explodes a `r` array into one line per
 * pair, which turns a 40 KB map into an unreadable multi-thousand-line diff.
 */
function stringifyPretty(v, depth) {
  const pad = '  '.repeat(depth);
  const padIn = '  '.repeat(depth + 1);
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (isFlatArray(v)) return JSON.stringify(v);
    return `[\n${v.map((x) => padIn + stringifyPretty(x, depth + 1)).join(',\n')}\n${pad}]`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return '{}';
  return `{\n${keys.map((k) => `${padIn}${JSON.stringify(k)}: ${stringifyPretty(v[k], depth + 1)}`).join(',\n')}\n${pad}}`;
}

/** @param {object} map @returns {string} pretty JSON, trailing newline, diff-friendly */
export function serializeMapFile(map) {
  return `${stringifyPretty(map, 0)}\n`;
}

// --- draft -> map file ------------------------------------------------------------------------

/** @param {import('./draft.js').MapDraft} draft @param {(tileset:string, modelId:number) => {name:string,w?:number,h?:number}|null} resolveModel */
function buildDraftLayer(draft, resolveModel) {
  const n = draft.w * draft.h;
  const byLayer = new Map();
  for (const p of draft.placements) {
    if (!byLayer.has(p.layer)) byLayer.set(p.layer, []);
    byLayer.get(p.layer).push(p);
  }

  const modelNames = [];
  const modelIds = [];
  const modelIndex = new Map();
  const infoByIndex = [];
  function paletteFor(modelId) {
    const info = resolveModel(draft.tileset, modelId);
    const name = info?.name ?? `#${modelId}`;
    let idx = modelIndex.get(name);
    if (idx === undefined) {
      idx = modelNames.length;
      modelNames.push(name);
      modelIds.push(modelId);
      infoByIndex.push(info);
      modelIndex.set(name, idx);
    }
    return idx;
  }

  const tiles = [];
  const objects = [];

  for (const [layer, placements] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    const originCount = new Map();
    for (const p of placements) {
      const k = `${p.cx},${p.cz}`;
      originCount.set(k, (originCount.get(k) ?? 0) + 1);
    }

    const modelAt = new Array(n).fill(-1);
    const rotAt = new Array(n).fill(0);
    const tintAt = new Array(n).fill(DEFAULT_TINT);
    const yAt = new Array(n).fill(null);
    let anyRot = false;
    let anyTint = false;
    let anyY = false;

    for (const p of placements) {
      const idx = paletteFor(p.modelId);
      const info = infoByIndex[idx];
      const k = `${p.cx},${p.cz}`;
      const eligible = originCount.get(k) === 1 && (info?.w ?? 1) === 1 && (info?.h ?? 1) === 1;
      const baseY = draft.heightAt(p.cx, p.cz);
      const yOverride = Math.abs((p.y ?? baseY) - baseY) > 1e-6 ? round3(p.y) : null;

      if (eligible) {
        const i = draft.idx(p.cx, p.cz);
        modelAt[i] = idx;
        if (p.rot) { rotAt[i] = p.rot; anyRot = true; }
        if (p.tint !== undefined && p.tint !== DEFAULT_TINT) { tintAt[i] = p.tint; anyTint = true; }
        if (yOverride !== null) { yAt[i] = yOverride; anyY = true; }
      } else {
        const obj = { m: idx, cx: p.cx, cz: p.cz, layer };
        if (p.rot) obj.rot = p.rot;
        if (p.tint !== undefined && p.tint !== DEFAULT_TINT) obj.tint = p.tint;
        if (yOverride !== null) obj.y = yOverride;
        objects.push(obj);
      }
    }

    const entry = { layer, model: encodeRuns(modelAt) };
    if (anyRot) entry.rot = encodeRuns(rotAt);
    if (anyTint) entry.tint = encodeRuns(tintAt);
    if (anyY) entry.y = encodeRuns(yAt);
    tiles.push(entry);
  }

  return { tileset: draft.tileset, role: 'draft', models: modelNames, modelIds, tiles, objects };
}

/** @param {string} tileset @param {object[]} placements @param {Function} resolveModel
 *  @param {object} [options] `InstancedWorld` build options this group needs (`castShadow`,
 *  `variety`) — carried so a round trip does not lose "this tileset's lamps don't cast
 *  shadows" once it's a plain file-authored extras layer instead of a hand-built world. */
function buildExtraLayer(tileset, placements, resolveModel, options) {
  const modelNames = [];
  const modelIds = [];
  const modelIndex = new Map();
  function paletteFor(modelId) {
    const info = resolveModel(tileset, modelId);
    const name = info?.name ?? `#${modelId}`;
    let idx = modelIndex.get(name);
    if (idx === undefined) {
      idx = modelNames.length;
      modelNames.push(name);
      modelIds.push(modelId);
      modelIndex.set(name, idx);
    }
    return idx;
  }
  const objects = placements.map((p) => {
    const obj = { m: paletteFor(p.modelId), cx: p.cx, cz: p.cz, layer: p.layer ?? 0 };
    if (p.rot) obj.rot = p.rot;
    if (p.tint !== undefined && p.tint !== DEFAULT_TINT) obj.tint = p.tint;
    if (p.y !== undefined) obj.y = round3(p.y);
    return obj;
  });
  const entry = { tileset, role: 'extra', models: modelNames, modelIds, objects };
  if (options && Object.keys(options).length) entry.options = { ...options };
  return entry;
}

function buildGrid(draft) {
  const n = draft.w * draft.h;
  const collision = Array.from(draft.collision);
  const height = Array.from(draft.height, round3);
  const tags = Array.from({ length: n }, (_, i) => draft.tags[i] ?? []);
  const occupied = Array.from(draft.occupied);
  return {
    collision: encodeRuns(collision),
    height: encodeRuns(height),
    tags: encodeRuns(tags),
    occupied: encodeRuns(occupied),
  };
}

/**
 * Freezes a finalized `MapDraft` into a map file.
 *
 * @param {import('./draft.js').MapDraft} draft already `.finalize()`d
 * @param {object} opts
 * @param {(tileset:string, modelId:number) => {name:string,w?:number,h?:number}|null} opts.resolveModel
 *   looks a placement's numeric model id up in its tileset's catalog — `(slug,id) =>
 *   tiles.byId(slug,id)` from the caller's loaded `tiles` module.
 * @param {{tileset:string, placements:object[], options?:object}[]} [opts.extras] the second/
 *   third/fourth `InstancedWorld`s a scene composited on top (buildings, props, dressing).
 */
export function draftToMapFile(draft, opts) {
  const layers = [buildDraftLayer(draft, opts.resolveModel)];
  // A scene can build several separate `InstancedWorld`s off the same extra tileset with
  // different build options (`city`'s buildings cast shadows, its lamp posts and paving do
  // not — `src/terrain/populate.js`'s `buildExtras`). `frommap.js`'s replay buckets by
  // `(tileset, options)` on the way back in, so the exporter groups here the same way — one
  // `layers[]` entry per distinct (tileset, options) pair — or a snapshot and its own round
  // trip disagree on layer count for no reason a diff can explain.
  const extrasByGroup = new Map();
  for (const ex of opts.extras ?? []) {
    const key = `${ex.tileset} ${JSON.stringify(ex.options ?? {})}`;
    let group = extrasByGroup.get(key);
    if (!group) { group = { tileset: ex.tileset, options: ex.options ?? {}, placements: [] }; extrasByGroup.set(key, group); }
    group.placements.push(...ex.placements);
  }
  for (const { tileset, options, placements } of extrasByGroup.values()) {
    layers.push(buildExtraLayer(tileset, placements, opts.resolveModel, options));
  }

  const markers = [...draft.markers.entries()].map(([name, m]) => {
    const { cx, cz, ...rest } = m;
    return { name, cx, cz, ...rest };
  });

  return {
    format: FORMAT,
    version: VERSION,
    id: draft.id,
    name: opts.name ?? draft.id,
    kind: opts.kind ?? 'hunt',
    module: opts.module ?? null,
    w: draft.w,
    h: draft.h,
    tileset: draft.tileset,
    seed: draft.seed,
    requiredLevel: opts.requiredLevel ?? 0,
    weather: opts.weather ?? null,
    environmentPreset: opts.environmentPreset ?? DEFAULT_ENVIRONMENT_PRESET,
    // The map's own yield-multiplier profile — `idle/accrual.js` reads this off
    // `terrain.handle().economy`. See this file's own header (version 2).
    economy: opts.economy ?? { ...DEFAULT_ECONOMY, favours: { ...DEFAULT_ECONOMY.favours } },
    grid: buildGrid(draft),
    layers,
    regions: opts.regions ?? [],
    spawn: opts.spawn ? { ...opts.spawn } : { ...draft.spawn },
    markers,
    loop: opts.loop ?? null,
    // Wild spawn points — each one owns its own respawn timer and its own weighted list of
    // species (`{id, cx, cz, dir, respawnSeconds, species:[{name, chance, when?, bump?}]}`).
    // Placed directly by the Studio author; no longer derived from the patrol loop.
    spawnPoints: opts.spawnPoints ?? [],
    // Free-form category tags (`'cave'`, `'coastal'`, …) a consumer checks with `.includes`
    // rather than an identity lookup — see `terrain.handle()`'s own doc for why this is not
    // folded into a single lookup key.
    tags: opts.tags ?? [],
    npcs: opts.npcs ?? [],
    links: opts.links ?? [],
    lights: opts.lights ?? [],
    cameras: opts.cameras ?? null,
    formation: opts.formation ?? null,
  };
}
