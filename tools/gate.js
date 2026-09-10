#!/usr/bin/env node
/**
 * The gate. `npm run gate` exiting 0 is what "done" means (ARCHITECTURE §11).
 *
 *   npm run gate
 *   npm run gate -- --skip regress        # while a baseline re-accept is pending
 *
 * Five stages, cheapest first, so a broken contract fails in two seconds rather than after
 * a full screenshot matrix:
 *
 *   1. seams     static contracts + every src/<module>/selftest.js under Node
 *   2. build     the production build, which nothing used to run — everything was verified
 *                against the dev server, so a Vite build break was silent until deploy. It
 *                also asserts the build CONTAINS what the game fetches: `assets/` is served
 *                from the project root in dev and copied into `dist/` by a plugin, and when
 *                that plugin did not exist the build shipped with no sprite art and every
 *                other stage stayed green (DECISIONS #72)
 *   3. coldboot  §7's time-to-__READY__ budget, measured against that build on `vite preview`
 *   4. boot      every showcase and every scene draws a real frame, not an empty void
 *   5. parity    the pixel grid is identical across seven viewports
 *   6. regress   the fixed frame matrix against docs/baseline.json
 *
 * Everything that needs a browser gets one server, started here if the port is cold and
 * stopped on the way out, and every artifact is written under `shots/out/` — which is
 * ignored, so a gate run never dirties the working tree.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureServer, servePreview } from './shots/serve.js';
import { RUNTIME_ASSET_ROOTS } from '../vite.config.js';

const args = process.argv.slice(2);
const skip = new Set();
for (let i = 0; i < args.length; i++) if (args[i] === '--skip') skip.add(args[++i]);

const OUT = 'shots/out';
mkdirSync(OUT, { recursive: true });

// One port for the whole run, so `GATE_PORT=5199 npm run gate` starts the server and shoots
// at the same place. Without threading it through, the server would move and the harness
// would keep knocking on 5173.
const PORT = Number(process.env.GATE_PORT ?? 5173);
const BASE = `http://127.0.0.1:${PORT}`;

/** @type {{name:string, argv:string[], needsServer:boolean}[]} */
const STAGES = [
  { name: 'seams', argv: ['tools/seams/run.js'], needsServer: false },
  { name: 'build', argv: null, needsServer: false },
  { name: 'coldboot', argv: null, needsServer: false },
  { name: 'boot', argv: ['tools/shots/boot.js', '--out', `${OUT}/boot`, '--base', BASE], needsServer: true },
  { name: 'parity', argv: ['tools/shots/parity.js', '--out', `${OUT}/parity`, '--base', BASE], needsServer: true },
  { name: 'regress', argv: ['tools/shots/regress.js', '--out', `${OUT}/regress`, '--base', BASE], needsServer: true },
];

/**
 * Everything the browser fetches from `/assets/` is actually in `dist/`.
 *
 * The reason this exists: `boot.js` and `regress.js` shoot the **dev server**, which serves the
 * project root, so a file that never reached the build is still there for every capture. The one
 * stage that used the build measured time to `__READY__`, and an untextured quad is as fast to
 * draw as a textured one. The result was a production bundle with no Pokemon sprites in it and a
 * gate that passed every stage (DECISIONS #72).
 *
 * Derived, not listed: the roots come from `vite.config.js` (so the plugin and the check cannot
 * disagree) and the URLs come from grepping `src/` (so a new fetch is covered the day it lands).
 */
function builtAssets() {
  const fails = [];
  for (const root of RUNTIME_ASSET_ROOTS) {
    const dir = join('dist', 'assets', root);
    if (!existsSync(dir)) { fails.push(`dist/assets/${root} is missing — the build shipped without it`); continue; }
    const n = readdirSync(dir).length;
    if (!n) fails.push(`dist/assets/${root} is empty`);
    else console.log(`  ✓ dist/assets/${root} — ${n} entries`);
  }

  // Every `/assets/<root>/` URL `src/` builds must be one the plugin copies. A new one added
  // without touching `vite.config.js` is exactly the failure this stage is here to catch.
  const referenced = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/["'`]\/assets\/([a-z0-9-]+)\//g)) referenced.add(m[1]);
    }
  };
  walk('src');
  for (const root of referenced) {
    if (!RUNTIME_ASSET_ROOTS.includes(root)) {
      fails.push(`src/ fetches /assets/${root}/ but vite.config.js does not copy it into the build`);
    }
  }

  for (const f of fails) console.log(`  ✗ ${f}`);
  return fails.length ? 1 : 0;
}

const noop = () => {};
let stop = noop;
const failures = [];

/**
 * §7: time to `__READY__` <= 6 s cold. Measured once, against the production bundle on
 * `vite preview` — never against the dev server, which serves several hundred unbundled
 * modules and compiles them on demand (DECISIONS #71).
 */
async function coldBoot() {
  const port = PORT + 1;
  const stopPreview = await servePreview(port);
  try {
    const { shoot, checkBudgets } = await import('./shots/shoot.js');
    const a = {
      base: `http://127.0.0.1:${port}`, out: `${OUT}/coldboot.png`,
      size: '1280x720', tod: 12, settle: 30, timeout: 45000, retries: 2,
      readyBudget: 6000, extra: {},
    };
    const log = await shoot(a);
    const fails = checkBudgets(log, a);
    console.log(`${fails.length ? '✗' : '✓'} production boot: ready in ` +
      `${((log.readyMs ?? 0) / 1000).toFixed(1)}s (budget 6s), ${log.drawCalls ?? '?'} draws`);
    for (const f of fails) console.log(`   ! ${f}`);
    return fails.length ? 1 : 0;
  } finally {
    stopPreview();
  }
}

for (const stage of STAGES) {
  if (skip.has(stage.name)) { console.log(`\n— ${stage.name}: skipped\n`); continue; }
  console.log(`\n${'='.repeat(72)}\n  ${stage.name}\n${'='.repeat(72)}`);

  // Started once, on the first stage that needs it, and stopped after the last.
  if (stage.needsServer && stop === noop) stop = await ensureServer();

  let r;
  if (stage.name === 'build') {
    r = spawnSync('npx', ['vite', 'build'], { stdio: 'inherit' });
    if (r.status === 0) r = { status: builtAssets() };
  } else if (stage.name === 'coldboot') {
    r = { status: await coldBoot() };
  } else {
    r = spawnSync(process.execPath, stage.argv, { stdio: 'inherit' });
  }

  if (r.status !== 0) {
    failures.push(stage.name);
    // Keep going: one report of everything that is red beats five runs finding one each.
    console.log(`\n✗ ${stage.name} failed (exit ${r.status})`);
  }
}

stop();

console.log(`\n${'='.repeat(72)}`);
if (!failures.length) {
  console.log('✓ gate: every stage passed');
  process.exit(0);
}
console.log(`✗ gate: ${failures.join(', ')} failed`);
// A deliberate visual change is *expected* to move regress metrics. Say so here, so a
// correct change does not read as a broken one.
if (failures.includes('regress')) {
  console.log('  · regress moved. If the change was deliberate, re-accept the baseline in the');
  console.log('    same commit (node tools/shots/regress.js --accept) and name the moved frames.');
}
process.exit(1);
