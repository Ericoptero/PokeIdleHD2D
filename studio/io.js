/**
 * io.js — getting a map file in and out of the Studio.
 *
 * Persistence today is import/export only (the user's own choice for this slice): a
 * `.map.json` downloaded to disk, or dragged back in. No server write path exists yet — when
 * one does, this is the module that grows a `save()` that PUTs instead of downloading, and
 * every call site (`main.js`) stays the same.
 */

import { parseMapFile, serializeMapFile } from '@/terrain/mapfile.js';

/** @returns {Promise<{id:string,name:string,kind:string}[]>} the maps the game ships, if any were snapshotted */
export async function listGameMaps() {
  try {
    const res = await fetch('/maps/index.json', { cache: 'no-store' });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/** @param {string} id @returns {Promise<object>} a parsed map file */
export async function loadGameMap(id) {
  const res = await fetch(`/maps/${id}.map.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`io: /maps/${id}.map.json ${res.status}`);
  return parseMapFile(await res.json());
}

/** Opens the browser's file picker and parses the chosen `.map.json`. @returns {Promise<object|null>} */
export function importFile() {
  return new Promise((resolveFile) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolveFile(null);
      try {
        resolveFile(parseMapFile(await file.text()));
      } catch (err) {
        alert(`Não foi possível importar o arquivo: ${err.message}`);
        resolveFile(null);
      }
    };
    input.click();
  });
}

/** Downloads `map` as `<id>.map.json`. The sandboxed preview cannot trigger a real download —
 *  this is for the deployed Studio, where a plain `<a download>` works normally. */
export function exportFile(map) {
  const text = serializeMapFile(map);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${map.id}.map.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
