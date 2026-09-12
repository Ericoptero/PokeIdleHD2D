#!/usr/bin/env node
/**
 * Optional visual regression measurements against a fixed frame matrix.
 * Metrics carry a direction: `belowL8Pct` should go down, `p99` should go up.
 * Reports IMPROVED, SAME and REGRESSED for comparison with docs/baseline.json.
 *
 *   node tools/shots/regress.js                 # compare against docs/baseline.json
 *   node tools/shots/regress.js --accept        # store the current numbers as the baseline
 *   node tools/shots/regress.js --only hunts    # one module's rows
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shoot } from './shoot.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = join(REPO, 'docs', 'baseline.json');
// Generated captures use an ignored directory; --out selects another destination.
const DEFAULT_SHOTS = join(REPO, 'shots', 'out', 'regress');

/** The frames that are actually judged, plus the ones that have regressed before. */
export const MATRIX = [
  { id: 'hunts/forest/12', showcase: 'hunts', mode: 'forest', tod: 12 },
  { id: 'hunts/forest/17.5', showcase: 'hunts', mode: 'forest', tod: 17.5 },
  { id: 'hunts/forest/21', showcase: 'hunts', mode: 'forest', tod: 21 },
  { id: 'hunts/meadow/12', showcase: 'hunts', mode: 'meadow', tod: 12 },
  { id: 'hunts/meadow/21', showcase: 'hunts', mode: 'meadow', tod: 21 },
  { id: 'hunts/cave/12', showcase: 'hunts', mode: 'cave', tod: 12 },
  { id: 'hunts/coast/12', showcase: 'hunts', mode: 'coast', tod: 12 },
  { id: 'city/plaza/12', showcase: 'city', preset: 'plaza', tod: 12 },
  { id: 'city/high-street/17.5', showcase: 'city', preset: 'high-street', tod: 17.5 },
  { id: 'city/high-street/21', showcase: 'city', preset: 'high-street', tod: 21 },
  { id: 'pokecenter/12', showcase: 'pokecenter', tod: 12 },
  { id: 'tiles/12', showcase: 'tiles', tod: 12 },
  // environment's own showcase, because its critic caught the gate missing half a round:
  // "MATRIX has no showcase:'environment' row, so every pixel of the showcase.js rewrite
  // passed the gate untested". A gate nobody can see through is worse than no gate.
  { id: 'environment/12', showcase: 'environment', tod: 12 },
  { id: 'environment/17.5', showcase: 'environment', tod: 17.5 },
  { id: 'encounter/12', showcase: 'encounter', tod: 12 },
  // The move effects, at the two hours the grade differs most. A strike is the one thing in
  // this module a still frame can show and a histogram can nearly see: the first cut washed
  // out at noon and the redraw had to be checked again at night, where `environment` lifts the
  // bloom threshold. Without a row here neither would be noticed again.
  { id: 'encounter/vfx/12', showcase: 'encounter', mode: 'vfx-contact', tod: 12 },
  { id: 'encounter/vfx/21', showcase: 'encounter', mode: 'vfx-contact', tod: 21 },
  // The other two deliveries, one row each (shader VFX) — without these, a
  // beam's travel or a ground ring's growth could break and only `vfx-contact`'s own row
  // would ever be re-checked.
  { id: 'encounter/vfx-projectile/12', showcase: 'encounter', mode: 'vfx-projectile', tod: 12 },
  { id: 'encounter/vfx-field/21', showcase: 'encounter', mode: 'vfx-field', tod: 21 },
  { id: 'boot/12', tod: 12 },
];

/**
 * `dir` is which way is better. `tol` is how much movement counts as noise rather than a
 * change — set from the observed run-to-run spread, not from taste.
 */
const METRICS = {
  fps:          { dir: +1, tol: 2 },
  drawCalls:    { dir: -1, tol: 8 },
  consoleErrors:{ dir: -1, tol: 0 },
  mean:         { dir: 0,  tol: 4 },
  p99:          { dir: +1, tol: 4 },
  max:          { dir: +1, tol: 4 },
  belowL8Pct:   { dir: -1, tol: 0.8 },
  pureBlackPct: { dir: -1, tol: 0.5 },
  over200Pct:   { dir: +1, tol: 0.4 },
  saturation:   { dir: 0,  tol: 0.03 },
};

function parse(argv) {
  const a = { accept: false, only: null, size: '1280x720', base: 'http://127.0.0.1:5173', hudRows: 60 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--accept') a.accept = true;
    else if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) a[k] = argv[++i];
      else a[k] = true;
    }
  }
  return a;
}

export async function measure(a) {
  const rows = MATRIX.filter((m) => !a.only || m.id.startsWith(a.only));
  const out = {};
  const shots = a.out ?? DEFAULT_SHOTS;
  mkdirSync(shots, { recursive: true });
  for (const m of rows) {
    const file = join(shots, `${m.id.replace(/[/.]/g, '_')}.png`);
    const log = await shoot({
      base: a.base, out: file, size: a.size, settle: 40, hudRows: a.hudRows,
      showcase: m.showcase ?? null, mode: m.mode ?? null, preset: m.preset ?? null,
      tod: m.tod, seed: 1337, timeout: 45000, retries: 3, extra: {},
    });
    out[m.id] = log.ok
      ? {
        fps: log.fps?.mean ?? null, drawCalls: log.drawCalls ?? null,
        consoleErrors: (log.consoleErrors ?? []).length,
        ...(log.scene ?? {}),
      }
      : { error: log.error ?? 'capture failed' };
    delete out[m.id].pixels;
  }
  return out;
}

function compare(base, now) {
  const rows = [];
  for (const id of Object.keys(now)) {
    const b = base[id], n = now[id];
    if (!b) { rows.push({ id, metric: '(new row)', verdict: 'NEW' }); continue; }
    if (n.error) { rows.push({ id, metric: 'capture', verdict: 'REGRESSED', from: 'ok', to: n.error }); continue; }
    for (const [k, spec] of Object.entries(METRICS)) {
      if (b[k] == null || n[k] == null) continue;
      const d = n[k] - b[k];
      if (Math.abs(d) <= spec.tol) continue;
      const better = spec.dir === 0 ? null : (spec.dir > 0 ? d > 0 : d < 0);
      rows.push({
        id, metric: k, from: b[k], to: n[k], delta: +d.toFixed(3),
        verdict: better === null ? 'MOVED' : better ? 'IMPROVED' : 'REGRESSED',
      });
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parse(process.argv.slice(2));
  const now = await measure(a);

  if (a.accept || !existsSync(BASELINE)) {
    const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { rows: {} };
    writeFileSync(BASELINE, JSON.stringify({ size: a.size, hudRows: a.hudRows, rows: { ...prev.rows, ...now } }, null, 1));
    console.log(`baseline ${existsSync(BASELINE) ? 'updated' : 'created'}: ${Object.keys(now).length} rows -> docs/baseline.json`);
    process.exit(0);
  }

  const base = JSON.parse(readFileSync(BASELINE, 'utf8')).rows ?? {};
  const rows = compare(base, now);
  const bad = rows.filter((r) => r.verdict === 'REGRESSED');
  const good = rows.filter((r) => r.verdict === 'IMPROVED');

  for (const r of bad) console.log(`REGRESSED  ${r.id.padEnd(26)} ${r.metric.padEnd(14)} ${r.from} -> ${r.to}`);
  for (const r of good) console.log(`improved   ${r.id.padEnd(26)} ${r.metric.padEnd(14)} ${r.from} -> ${r.to}`);
  for (const r of rows.filter((x) => x.verdict === 'MOVED')) {
    console.log(`moved      ${r.id.padEnd(26)} ${r.metric.padEnd(14)} ${r.from} -> ${r.to}  (no better/worse direction)`);
  }
  console.log(`\n${good.length} improved, ${bad.length} regressed, ${rows.length - good.length - bad.length} moved, across ${Object.keys(now).length} frames.`);
  process.exit(bad.length ? 1 : 0);
}
