/**
 * index.js — builds `public/maps/index.json`, the manifest the Studio's map picker
 * (`studio/io.js`'s `listGameMaps`) fetches to know what the game ships.
 *
 * Shared by `tools/mapstudio/snapshot.js` (after writing a batch of snapshots) and the Vite
 * dev-server save endpoint (`vite.config.js`'s Studio-save plugin, after one Salvar) so the
 * two writers can't drift on shape. A directory scan rather than an in-memory list: it stays
 * correct after any subset of files changed — one Studio save, a partial `--only` re-snapshot,
 * a map deleted by hand — where building the index only from what a single call just wrote
 * would silently drop every map it didn't touch.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} dir a directory of `*.map.json` files (e.g. `public/maps`)
 * @returns {{id:string, name:string, kind:string, w:number, h:number}[]} what was written
 */
export function rebuildMapsIndex(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.map.json'));
  const index = files.map((f) => {
    const map = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return { id: map.id, name: map.name, kind: map.kind, w: map.w, h: map.h };
  }).sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return index;
}
