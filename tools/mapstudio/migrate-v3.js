#!/usr/bin/env node
/**
 * migrate-v3.js — one-time transform of the six shipped `.map.json` files (v2 -> v3).
 *
 *   node tools/mapstudio/migrate-v3.js [--dir public/maps] [--dry]
 *
 * Per file (see `src/terrain/mapfile.js`'s own header, "Version 3", for the reasoning behind
 * each of these):
 *
 *   - drop `module` (write-only — nothing at runtime ever read it back) and, from every
 *     `layers[]` entry, `modelIds` (the id-fallback `frommap.js`'s resolver no longer has)
 *   - mint a stable `id` for any `lights[]`/`regions[]` entry that lacks one, matching the
 *     pattern `spawnPoints[]` (and the Studio's own `addSpawnPoint`) already use
 *   - recompute `grid.occupied` from each object's real footprint (resolved against the
 *     tileset's own build catalog under `public/generated/tiles/`) and compare it against the
 *     shipped value — a mismatch is a warning, never a silent overwrite. This DOES disagree for
 *     four of the six shipped maps, confirmed by hand rather than assumed to be a bug in this
 *     script: `demo-city` carries building-plot reservations the retired pre-Studio city
 *     builder stamped straight onto `draft.occupied` with no placement behind them at all
 *     (`git show 9876a49~1:src/city/map.js`), and `hunt-cave`/`hunt-forest`/`hunt-meadow`
 *     disagree the other way — the current tileset catalogs claim MORE cells than they shipped
 *     with, because prop dimensions have drifted since these files were frozen. Either way, a
 *     human should look at the disagreement rather than have a script silently overwrite
 *     whatever `MapDraft.place()` actually stamped when the map was built.
 *   - backfill exactly the one door link already wired end-to-end in the shipped maps —
 *     `demo-city`'s Poké Center door and its matching exit in `pokecenter` — using each file's
 *     own door-tagged cell (`grid.tags`) and marker name, confirmed against the files in this
 *     worktree rather than assumed. Every other `door:*` tag in `demo-city` (mart, the four
 *     houses) has no destination map authored yet and is deliberately left alone.
 *
 * Everything else round-trips untouched — `version: 2 -> 3` and the two edits above are the
 * whole of what this script does; a v2 file already carries everything else a v3 map needs.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeMapFile, decodeRuns } from '../../src/terrain/mapfile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The one door link already wired end-to-end in the shipped maps. `tag` is the `door:*` cell
 * tag (`grid.tags`) this file's own arrival side is found at; `link` is the entry to add
 * (`from` is filled in once `tag`'s cell is located). `ensureMarker`, when present, backfills
 * a marker the destination side names but does not yet have.
 */
const DOOR_LINKS = {
  'demo-city': {
    tag: 'door:pokecenter',
    link: { id: 'demo-city->pokecenter', kind: 'door', to: { map: 'pokecenter', marker: 'spawn', dir: 2 } },
    ensureMarker: null,
  },
  pokecenter: {
    tag: 'door:pokecenter-exit',
    link: { id: 'pokecenter->demo-city', kind: 'door', to: { map: 'demo-city', marker: 'pokecenter-door', dir: 0 } },
    // `pokecenter.map.json` only ever authored an `exit` marker (at its own door) — never one
    // named `spawn`, which `demo-city`'s link (above) arrives at by name. Backfilled here at
    // whatever the file's own `spawn` field already says, not a guessed cell.
    ensureMarker: (map) => ({ name: 'spawn', cx: map.spawn.cx, cz: map.spawn.cz }),
  },
};

function findTaggedCell(map, tag) {
  const n = map.w * map.h;
  const tags = decodeRuns(map.grid.tags, n);
  for (let i = 0; i < n; i++) {
    if (tags[i]?.includes(tag)) return { cx: i % map.w, cz: Math.floor(i / map.w) };
  }
  return null;
}

function mintId(prefix, index) {
  return `${prefix}-${index}-${Date.now().toString(36)}`;
}

/** Rotated footprint extents — mirrors `src/tiles/instanced.js`'s exported `footprint()`. */
function footprintOf(w, h, rot) {
  return (rot & 1) ? { w: h, h: w } : { w, h };
}

const catalogCache = new Map();
/** @param {string} slug @returns {{byName:Map<string,object>}|null} `null` if the tileset has
 *  no build output on disk (should not happen for a shipped map, but this is a report, not an
 *  assertion — a missing catalog just means that layer's contribution is skipped below). */
function loadCatalog(slug) {
  if (catalogCache.has(slug)) return catalogCache.get(slug);
  let cat;
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'public/generated/tiles', slug, 'catalog.json'), 'utf8'));
    cat = { byName: new Map(raw.models.map((m) => [m.name, m])) };
  } catch {
    cat = null;
  }
  catalogCache.set(slug, cat);
  return cat;
}

/**
 * Mirrors `MapDraft.place()`'s own rule (`src/terrain/draft.js`): a placement only ever claims
 * a cell in `grid.occupied` when its rotated footprint is wider than 1x1. Extras never touch
 * `occupied` at all (`frommap.js`'s replay routes them to a separate `InstancedWorld`, never
 * through `draft.place`), so only `role:"draft"` layers are walked here.
 */
function recomputeOccupied(map) {
  const n = map.w * map.h;
  const out = new Array(n).fill(0);
  for (const layer of map.layers ?? []) {
    if (layer.role === 'extra') continue;
    const cat = loadCatalog(layer.tileset);
    if (!cat) continue;
    for (const o of layer.objects ?? []) {
      const name = layer.models?.[o.m];
      const model = name != null ? cat.byName.get(name) : null;
      if (!model) continue;
      const { w, h } = footprintOf(model.w ?? 1, model.h ?? 1, o.rot ?? 0);
      if (w <= 1 && h <= 1) continue;
      for (let dz = 0; dz < h; dz++) {
        for (let dx = 0; dx < w; dx++) {
          const cx = o.cx + dx;
          const cz = o.cz + dz;
          if (cx < 0 || cz < 0 || cx >= map.w || cz >= map.h) continue;
          out[cz * map.w + cx] = 1;
        }
      }
    }
  }
  return out;
}

function migrate(map) {
  const { module: _module, ...rest } = map;

  const layers = (rest.layers ?? []).map((l) => {
    const { modelIds: _modelIds, ...layerRest } = l;
    return layerRest;
  });

  const lights = (rest.lights ?? []).map((l, i) => (l.id ? l : { ...l, id: mintId('light', i) }));
  const regions = (rest.regions ?? []).map((r, i) => (r.id ? r : { ...r, id: mintId('region', i) }));

  const n = map.w * map.h;
  const shippedOccupied = decodeRuns(map.grid.occupied, n);
  const recomputed = recomputeOccupied({ ...rest, layers });
  const occupiedMatches = shippedOccupied.length === recomputed.length
    && shippedOccupied.every((v, i) => !!v === !!recomputed[i]);

  const links = [...(rest.links ?? [])];
  let markers = rest.markers ?? [];
  const doorSpec = DOOR_LINKS[map.id];
  let linkAdded = false;
  if (doorSpec && !links.some((l) => l.id === doorSpec.link.id)) {
    const from = findTaggedCell(map, doorSpec.tag);
    if (!from) {
      console.warn(`  ! ${map.id}: no cell tagged "${doorSpec.tag}" — link not added`);
    } else {
      links.push({ ...doorSpec.link, from });
      linkAdded = true;
      if (doorSpec.ensureMarker) {
        const wanted = doorSpec.ensureMarker(map);
        if (!markers.some((m) => m.name === wanted.name)) markers = [...markers, wanted];
      }
    }
  }

  return {
    migrated: {
      ...rest,
      version: 3,
      layers,
      lights,
      regions,
      links,
      markers,
    },
    report: {
      mintedLights: lights.filter((l, i) => !(rest.lights ?? [])[i]?.id).length,
      mintedRegions: regions.filter((r, i) => !(rest.regions ?? [])[i]?.id).length,
      occupiedMatches,
      linkAdded,
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const dir = join(ROOT, dirIdx >= 0 ? args[dirIdx + 1] : 'public/maps');
  const dry = args.includes('--dry');

  const files = readdirSync(dir).filter((f) => f.endsWith('.map.json'));
  let errors = 0;
  for (const f of files) {
    const path = join(dir, f);
    try {
      const map = JSON.parse(readFileSync(path, 'utf8'));
      if (map.version >= 3) { console.log(`skip  ${f} (already v${map.version})`); continue; }
      const { migrated, report } = migrate(map);
      console.log(`${dry ? 'would migrate' : 'migrate'}  ${f} — `
        + `${report.mintedLights} light id(s) minted, ${report.mintedRegions} region id(s) minted, `
        + `link ${report.linkAdded ? 'added' : 'unchanged'}, `
        + `occupied ${report.occupiedMatches ? 'matches' : 'DISAGREES (kept shipped value, review by hand)'}`);
      if (!report.occupiedMatches) {
        console.warn(`  ! ${f}: recomputed grid.occupied does not match the shipped array`);
      }
      if (!dry) {
        // Reuse the project's own pretty-printer (`mapfile.js`) so the output stays
        // diff-friendly, matching every other `.map.json` in the repo.
        writeFileSync(path, serializeMapFile(migrated), 'utf8');
      }
    } catch (err) {
      errors++;
      console.error(`✗ ${f}: ${err.message}`);
    }
  }
  if (errors) {
    console.error(`✗ migrate-v3 failed for ${errors}/${files.length} file(s)`);
    process.exitCode = 1;
  }
}

main();
