#!/usr/bin/env node
/**
 * Cross-module contract checks. Every rule is
 * derived from the tree at check time — nothing here is a list that has to be kept up.
 *
 *   node tools/seams/run.js
 *
 * Rules, in file order: 1 no Math.random; 2 no deep imports (static or dynamic); 3 module
 * descriptor shape; 4 the default tile pack is consistent; 5 economy's copy of idle's income
 * constants; 7 the drop catalogue mirrors the evolution bill; 8 every listened event is one
 * something emits; 6 every selftest passes and actually ran something.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, 'src');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const failures = [];
const fail = (rule, file, msg) => failures.push({ rule, file: relative(REPO, file), msg });

// --- 1. no Math.random in src/ (src/core/rng.js) --------------------------
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    // Comments may name the banned call — the ban is on calling it, not on explaining it.
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    if (/\bMath\.random\s*\(/.test(code) && !line.includes('seam-allow')) {
      fail('no-math-random', f, `line ${i + 1}: Math.random() is banned — use ctx.rng`);
    }
  });
}

// --- 2. no deep imports across modules (public index.js boundaries) --------------------
const MODULES = readdirSync(SRC, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'core').map((e) => e.name);

for (const f of files) {
  const owner = relative(SRC, f).split('/')[0];
  // Comments are stripped first: a JSDoc `@param {import('../terrain/draft.js').MapDraft}` is
  // a type reference, not a reach into the module. Static `from '../x/y.js'` and dynamic
  // `import('../x/y.js')` are then treated alike — a dynamic import reaches just as far.
  const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.\.\/[^'"]+)['"]/g)) {
    const spec = m[1];
    const target = relative(SRC, join(dirname(f), spec));
    const targetModule = target.split('/')[0];
    if (targetModule === owner || targetModule === 'core') continue;
    if (!MODULES.includes(targetModule)) continue;
    const isIndex = /(^|\/)index\.js$/.test(target) || target === targetModule;
    if (!isIndex) {
      fail('no-deep-imports', f,
        `imports "${spec}" from module "${targetModule}" — cross-module access goes through ctx.get('${targetModule}')`);
    }
  }
}

// --- 3. every module exports a valid descriptor -----------------------------
const REQUIRED_HOOKS = ['id', 'init'];
for (const m of MODULES) {
  const index = join(SRC, m, 'index.js');
  if (!existsSync(index)) { fail('module-shape', index, `module "${m}" has no index.js`); continue; }
  const src = readFileSync(index, 'utf8');
  if (!/export\s+default/.test(src)) fail('module-shape', index, 'no default export');
  for (const hook of REQUIRED_HOOKS) {
    if (!new RegExp(`(^|[\\s{,])${hook}\\s*[:(]`, 'm').test(src)) {
      fail('module-shape', index, `descriptor is missing "${hook}"`);
    }
  }
  if (!/showcase\s*[:(]/.test(src)) {
    fail('module-shape', index, 'no showcase() — required by the module descriptor contract');
  }
  if (!new RegExp(`id:\\s*['"]${m}['"]`).test(src)) {
    fail('module-shape', index, `descriptor id must be "${m}" (the folder name)`);
  }
}

// --- 4. generated assets are present ---------------------------------------
const tilesDir = join(REPO, 'public', 'generated', 'tiles');
if (!existsSync(join(tilesDir, 'bw2-adastra', 'pack.json'))) {
  fail('assets', tilesDir, 'bw2-adastra pack is missing — run `npm run assets`');
} else {
  const pack = JSON.parse(readFileSync(join(tilesDir, 'bw2-adastra', 'pack.json'), 'utf8'));
  const binBytes = statSync(join(tilesDir, 'bw2-adastra', 'pack.bin')).size;
  let maxEnd = 0;
  for (const m of pack.models) for (const g of m.groups ?? []) {
    maxEnd = Math.max(maxEnd, g.offset + g.count * pack.stride * 4);
  }
  if (maxEnd > binBytes) fail('assets', tilesDir, `pack.json references ${maxEnd} bytes but pack.bin is ${binBytes}`);
  const unnamed = pack.models.filter((m) => !m.empty && (!m.name || m.category === 'unknown'));
  if (unnamed.length) fail('assets', tilesDir,
    `${unnamed.length} bw2-adastra models are unclassified: ${unnamed.slice(0, 6).map((m) => m.name).join(', ')}`);
}

// --- 5. the balance table economy prices against still matches idle's ---------
// economy/pacing.js keeps a *copy* of idle's income constants so it can project 30 days of
// play without importing a module it does not depend on. That copy had already drifted once
// (BASE_MONEY 0.85 against 0.55) with nothing at runtime able to notice: the shop simply
// priced itself against a game that no longer existed. This is the notice.
{
  const accrual = await import(pathToFileURL(join(REPO, 'src', 'idle', 'accrual.js')).href);
  const pacing = await import(pathToFileURL(join(REPO, 'src', 'economy', 'pacing.js')).href);
  const model = pacing.INCOME_MODEL ?? {};
  const mirrored = ['BASE_MONEY', 'BASE_EXP', 'BASE_RESEARCH', 'BASE_ENCOUNTERS',
    'MONEY_POWER_EXP', 'TRAINER_BASE_POWER', 'SLOT_FALLOFF', 'LEAD_BONUS'];
  for (const key of mirrored) {
    const a = accrual[key];
    const b = model[key];
    if (a === undefined) { fail('balance-mirror', join(REPO, 'src/idle/accrual.js'), `accrual.js no longer exports ${key}`); continue; }
    if (b === undefined) { fail('balance-mirror', join(REPO, 'src/economy/pacing.js'), `INCOME_MODEL is missing ${key}`); continue; }
    const same = Array.isArray(a)
      ? Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
      : a === b;
    if (!same) {
      fail('balance-mirror', join(REPO, 'src/economy/pacing.js'),
        `${key}: idle says ${JSON.stringify(a)}, economy's copy says ${JSON.stringify(b)}`);
    }
  }
}

// --- 7. the drop catalogue matches the evolution bill --------------------------
// `pokemon/evolution.js` bills an evolution in twelve `treasure` items keyed by the child's
// type; `encounter/drops.js` hands the same twelve out keyed by the defeated wild's. Two views
// of one catalogue — and they have to be one catalogue, or a player
// grinds a wood for mushrooms to pay a bill that has quietly started asking for pearls.
//
// A copy rather than a shared file because seam rule 2 forbids the import and neither table
// belongs in `core`. Rule 5 sets the precedent and exists because exactly this kind of copy
// drifted once with nothing able to notice.
{
  const evo = await import(pathToFileURL(join(REPO, 'src', 'pokemon', 'evolution.js')).href);
  const drops = await import(pathToFileURL(join(REPO, 'src', 'encounter', 'drops.js')).href);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const key of ['MATERIAL_FAMILIES', 'FAMILY_BY_TYPE']) {
    const a = evo[key];
    const b = drops[key];
    if (a === undefined) { fail('drop-mirror', join(REPO, 'src/pokemon/evolution.js'), `evolution.js no longer exports ${key}`); continue; }
    if (b === undefined) { fail('drop-mirror', join(REPO, 'src/encounter/drops.js'), `drops.js is missing ${key}`); continue; }
    // Sorted, because the two files may list a family in whatever order reads best.
    const norm = (o) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
    if (!same(norm(a), norm(b))) {
      fail('drop-mirror', join(REPO, 'src/encounter/drops.js'),
        `${key} has drifted from pokemon/evolution.js`);
    }
  }
  // And every id either side names has to be a real item, or a drop is a no-op and an
  // evolution is unpayable.
  const items = await import(pathToFileURL(join(REPO, 'src', 'economy', 'items.js')).href);
  const bad = [...new Set(Object.values(drops.MATERIAL_FAMILIES ?? {}).flat())]
    .filter((id) => !items.item(id));
  if (bad.length) fail('drop-mirror', join(REPO, 'src/encounter/drops.js'), `not real items: ${bad.join(', ')}`);
}

// --- 8. every listened event is one something emits ---------------------------
// A `bus.on('catch:succeded')` — one letter off — compiles, runs, and simply never fires. The
// two sets are identical today, so this is green from the start and catches the rename that
// forgets a listener. Derived from the tree: nothing to keep up when an event is added.
{
  const emitted = new Set();
  const listened = new Map();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/bus\.emit\(\s*['"]([a-z]+:[a-zA-Z]+)['"]/g)) emitted.add(m[1]);
    for (const m of src.matchAll(/bus\.(?:on|once)\??\.?\(\s*['"]([a-z]+:[a-zA-Z]+)['"]/g)) {
      if (!listened.has(m[1])) listened.set(m[1], f);
    }
  }
  for (const [type, f] of listened) {
    if (!emitted.has(type)) fail('event-never-emitted', f, `listens for "${type}" and nothing in src/ emits it`);
  }
}

// --- 6. every module's own property checks ------------------------------------
// Any module may ship a `selftest.js` that exits non-zero on failure; they are discovered
// rather than listed, so a new one starts being enforced the moment it is written. These are
// the checks a screenshot cannot make — idle's 21 cover the chunk-additivity that idle and
// offline both rest on, and a break there is silent: the numbers stay plausible and stop
// being reproducible.
//
// `core` is in this list and in no other: it is not a module (no descriptor, no showcase, so
// the shape rule would fail it by construction) but it is the code every module imports, and
// leaving it unpinned meant `rng`, `clock`, `bus` and `registry` were only ever checked
// indirectly, by whichever module's goldens happened to run through them.
for (const m of [...MODULES, 'core']) {
  const selftest = join(REPO, 'src', m, 'selftest.js');
  if (!existsSync(selftest)) continue;
  const out = spawnSync(process.execPath, [selftest], { encoding: 'utf8', timeout: 120000 });
  const lines = (out.stdout ?? '').split('\n');
  if (out.status !== 0) {
    // `trimStart()`: hunts indents its failure lines, and a failure the report cannot quote is
    // a failure the reader has to reproduce before they can read it.
    const why = lines.map((l) => l.trimStart()).filter((l) => l.startsWith('✗')).slice(0, 6);
    fail('selftest', selftest,
      why.length ? why.join(' | ') : `exited ${out.status}: ${(out.stderr ?? '').slice(0, 200)}`);
    continue;
  }
  // Exit 0 is only a pass if something ran. `collection/selftest.js` exported its checks for the
  // browser showcase and had no main guard, so `node` on it exited 0 having run nothing, and
  // this rule counted it green for weeks. A selftest has to say what it checked.
  const ran = lines.some((l) => /^\s*[✓✗]/.test(l))
    || lines.some((l) => /\b\d+\s*\/\s*\d+\b/.test(l) || /\ball\s+\d+\s+checks?\b/.test(l));
  if (!ran) fail('selftest', selftest, 'exited 0 but printed no ✓/✗ line and no N/M summary — nothing ran');
}

// --- report ----------------------------------------------------------------
const byRule = new Map();
for (const f of failures) (byRule.get(f.rule) ?? byRule.set(f.rule, []).get(f.rule)).push(f);

if (!failures.length) {
  console.log(`✓ seams: ${files.length} files, ${MODULES.length} modules, all contracts hold`);
  process.exit(0);
}
for (const [rule, list] of byRule) {
  console.log(`✗ ${rule} (${list.length})`);
  for (const f of list.slice(0, 20)) console.log(`   ${f.file}: ${f.msg}`);
}
process.exit(1);
