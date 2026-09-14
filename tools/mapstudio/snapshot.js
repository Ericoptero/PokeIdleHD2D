#!/usr/bin/env node
/**
 * Freezes the six shipped maps into `public/maps/<id>.map.json` (`src/terrain/mapfile.js`).
 *
 *   node tools/mapstudio/snapshot.js [--out public/maps] [--only demo-city,hunt-forest]
 *
 * Drives `studio/snapshot.html` in headless Chrome exactly the way `tools/shots/shoot.js`
 * drives the game — see that page's own header for why a browser and not a Node script.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { CHROME, assertChrome, chromeArgs } from '../shots/chrome.js';
import { ensureServer } from '../shots/serve.js';
import { serializeMapFile } from '../../src/terrain/mapfile.js';
import { rebuildMapsIndex } from './index.js';

function parseArgs(argv) {
  const a = { out: 'public/maps', only: null, base: 'http://127.0.0.1:5173', timeout: 30000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    a[key] = next === undefined || next.startsWith('--') ? true : argv[++i];
  }
  return a;
}

export async function snapshotAll(opts = {}) {
  const a = { ...parseArgs(process.argv.slice(2)), ...opts };
  assertChrome();
  const outDir = resolve(a.out);
  mkdirSync(outDir, { recursive: true });
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

    const fatal = await page.evaluate(() => window.__FATAL__ ?? null);
    if (fatal) throw new Error(`snapshot page failed to boot: ${fatal}`);

    const list = await page.evaluate(() => window.__SNAPSHOT_LIST__());
    const ids = only ? list.filter((id) => only.includes(id)) : list;

    console.log(`· snapshotting ${ids.length} map(s): ${ids.join(', ')}`);
    for (const mapId of ids) {
      const t0 = Date.now();
      const map = await page.evaluate((id) => window.__SNAPSHOT__(id), mapId);
      const text = serializeMapFile(map);
      const file = resolve(outDir, `${mapId}.map.json`);
      writeFileSync(file, text, 'utf8');

      const placements = (map.layers ?? []).reduce((n, l) =>
        n + (l.tiles ?? []).reduce((m, t) => m + t.model.r.reduce((s, [, c]) => s + c, 0), 0) + (l.objects ?? []).length, 0);
      const objects = (map.layers ?? []).reduce((n, l) => n + (l.objects ?? []).length, 0);
      const ms = Date.now() - t0;
      results.push({ mapId, file, bytes: text.length, placements, objects, ms, map });
      console.log(`  ✓ ${mapId.padEnd(14)} ${(text.length / 1024).toFixed(1).padStart(7)} KB  ` +
        `${String(placements).padStart(6)} placements  ${String(objects).padStart(5)} objects  ${ms}ms`);
    }
  } finally {
    await browser.close();
    stopServer();
  }

  // A directory-scan rebuild (`./index.js`) rather than one built only from `results` — a
  // `--only` run still leaves every other shipped map's entry in `index.json` correct.
  rebuildMapsIndex(outDir);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  snapshotAll().then((results) => {
    const totalKb = results.reduce((n, r) => n + r.bytes, 0) / 1024;
    console.log(`· ${results.length} map(s) written, ${totalKb.toFixed(1)} KB total`);
  }).catch((err) => { console.error('✗ snapshot failed:', err); process.exit(1); });
}
