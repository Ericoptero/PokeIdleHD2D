#!/usr/bin/env node
/**
 * The round-trip proof: for each of the six shipped maps, freeze it (`before`), replay that
 * JSON through `src/terrain/frommap.js` and freeze the replay (`after`), then assert the two
 * are exactly equal on everything that matters — the four cell grids and the placement
 * multiset per layer. Not byte-identical JSON (the round-tripped draft's `id` differs, see
 * `studio/snapshot/main.js`'s `__ROUNDTRIP__`) but semantically identical maps.
 *
 *   node tools/mapstudio/roundtrip.js [--only demo-city,hunt-forest]
 *
 * This is the single most valuable check in the Map Studio: everything downstream (the
 * Studio's editor, and `terrain.registerMapFile` powering the game itself) rests on a JSON
 * map replaying to the exact draft it was frozen from.
 */

import puppeteer from 'puppeteer-core';
import { CHROME, assertChrome, chromeArgs } from '../shots/chrome.js';
import { ensureServer } from '../shots/serve.js';
import { decodeRuns } from '../../src/terrain/mapfile.js';

function parseArgs(argv) {
  const a = { only: null, base: 'http://127.0.0.1:5173', timeout: 30000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    a[key] = next === undefined || next.startsWith('--') ? true : argv[++i];
  }
  return a;
}

function grid(map, key) {
  return decodeRuns(map.grid[key], map.w * map.h);
}

/** A layer's tile grids decoded to `{layer, model, rot, tint, y}[]` (dense, one per cell). */
function decodeTiles(map, layer) {
  const n = map.w * map.h;
  return (layer.tiles ?? []).map((t) => ({
    layer: t.layer,
    model: decodeRuns(t.model, n).map((i) => (i < 0 ? null : layer.models[i])),
    rot: t.rot ? decodeRuns(t.rot, n) : null,
    tint: t.tint ? decodeRuns(t.tint, n) : null,
    y: t.y ? decodeRuns(t.y, n) : null,
  }));
}

/** A layer's `objects[]`, by model *name* (not palette index — indices differ across snapshots). */
function decodeObjects(layer) {
  return (layer.objects ?? []).map((o) => ({ ...o, m: layer.models[o.m] })).sort(byCell);
}

function byCell(a, b) {
  return a.layer - b.layer || a.cx - b.cx || a.cz - b.cz || String(a.m).localeCompare(String(b.m));
}

/** Compares two maps' semantic content; returns a list of human-readable mismatches (empty = pass). */
function diffMaps(before, after) {
  const problems = [];
  for (const key of ['collision', 'height', 'tags', 'occupied']) {
    const a = JSON.stringify(grid(before, key));
    const b = JSON.stringify(grid(after, key));
    if (a !== b) problems.push(`grid.${key} differs`);
  }

  const beforeLayers = [...(before.layers ?? [])].sort((x, y) => (x.tileset + x.role).localeCompare(y.tileset + y.role));
  const afterLayers = [...(after.layers ?? [])].sort((x, y) => (x.tileset + x.role).localeCompare(y.tileset + y.role));
  if (beforeLayers.length !== afterLayers.length) {
    problems.push(`layer count differs: ${beforeLayers.length} vs ${afterLayers.length}`);
  }
  for (let i = 0; i < Math.min(beforeLayers.length, afterLayers.length); i++) {
    const bl = beforeLayers[i];
    const al = afterLayers[i];
    if (bl.tileset !== al.tileset || bl.role !== al.role) {
      problems.push(`layer ${i}: tileset/role differs (${bl.tileset}/${bl.role} vs ${al.tileset}/${al.role})`);
      continue;
    }
    const bTiles = JSON.stringify(decodeTiles(before, bl));
    const aTiles = JSON.stringify(decodeTiles(after, al));
    if (bTiles !== aTiles) problems.push(`layer ${i} (${bl.tileset}/${bl.role}): tile grid differs`);

    const bObj = JSON.stringify(decodeObjects(bl));
    const aObj = JSON.stringify(decodeObjects(al));
    if (bObj !== aObj) problems.push(`layer ${i} (${bl.tileset}/${bl.role}): objects[] differs (${bl.objects?.length ?? 0} vs ${al.objects?.length ?? 0})`);
  }

  if (JSON.stringify(before.spawn) !== JSON.stringify(after.spawn)) problems.push('spawn differs');
  const bm = JSON.stringify([...(before.markers ?? [])].sort((x, y) => x.name.localeCompare(y.name)));
  const am = JSON.stringify([...(after.markers ?? [])].sort((x, y) => x.name.localeCompare(y.name)));
  if (bm !== am) problems.push('markers differ');

  return problems;
}

export async function roundtripAll(opts = {}) {
  const a = { ...parseArgs(process.argv.slice(2)), ...opts };
  assertChrome();
  const only = a.only && a.only !== true ? String(a.only).split(',') : null;

  const stopServer = await ensureServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--headless=new', ...chromeArgs(), '--window-size=960,720'],
    defaultViewport: { width: 960, height: 720, deviceScaleFactor: 1 },
  });

  const results = [];
  try {
    const page = await browser.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') console.error(`  [page] ${msg.text()}`); });
    await page.setCacheEnabled(false);
    await page.goto(`${a.base}/studio/snapshot.html`, { waitUntil: 'domcontentloaded', timeout: Number(a.timeout) });
    await page.waitForFunction('window.__READY__ === true', { timeout: Number(a.timeout), polling: 100 });

    const list = await page.evaluate(() => window.__SNAPSHOT_LIST__());
    const ids = only ? list.filter((id) => only.includes(id)) : list;
    console.log(`· round-tripping ${ids.length} map(s): ${ids.join(', ')}`);

    for (const mapId of ids) {
      const { before, after } = await page.evaluate((id) => window.__ROUNDTRIP__(id), mapId);
      const problems = diffMaps(before, after);
      results.push({ mapId, ok: problems.length === 0, problems });
      if (problems.length === 0) console.log(`  ✓ ${mapId}`);
      else {
        console.log(`  ✗ ${mapId}`);
        for (const p of problems) console.log(`      - ${p}`);
      }
    }
  } finally {
    await browser.close();
    stopServer();
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  roundtripAll().then((results) => {
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.error(`✗ round-trip failed for ${failed.length}/${results.length} map(s)`);
      process.exit(1);
    }
    console.log(`· round-trip exact for all ${results.length} map(s)`);
  }).catch((err) => { console.error('✗ roundtrip failed:', err); process.exit(1); });
}
