/**
 * io.js — getting a map file in and out of the Studio.
 *
 * Two write paths: `saveGameMap` PUTs to the dev-only server endpoint
 * (`vite.config.js`'s `studioSaveApi` plugin) so an edit lands straight in `public/maps/`, and
 * `exportFile` still downloads a standalone `.map.json` for anywhere the dev server isn't
 * running (the built `dist/`, a file to hand someone). `saveGameMap` only exists under
 * `npm run dev` — a build/preview host has no such endpoint, and the toolbar surfaces that
 * failure rather than pretending it saved.
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

/**
 * PUTs `map` to the dev server, which writes `public/maps/<id>.map.json` and rebuilds
 * `maps/index.json` (`vite.config.js`, `tools/mapstudio/index.js`). Throws with the server's
 * own error text on any failure — a 404 (no dev server / built host), a validation rejection
 * (`parseMapFile` failing server-side), or a network error all surface to the caller the same
 * way, so `panels.js` has one place to catch and report.
 * @param {object} map @returns {Promise<void>}
 */
export async function saveGameMap(map) {
  let res;
  try {
    res = await fetch(`/api/studio/maps/${encodeURIComponent(map.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: serializeMapFile(map),
    });
  } catch {
    throw new Error('não foi possível contatar o servidor de desenvolvimento (rodando com "npm run dev"?)');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try { message = JSON.parse(text).error ?? text; } catch { /* not JSON — use the raw text */ }
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
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
