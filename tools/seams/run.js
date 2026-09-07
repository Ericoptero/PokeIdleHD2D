#!/usr/bin/env node
/**
 * Cross-module contract checks (ARCHITECTURE §12). These are the rules the integrator
 * polices, expressed as code so a builder finds out before the critic does.
 *
 *   node tools/seams/run.js
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
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

// --- 1. no Math.random in src/ (ARCHITECTURE §2.5) --------------------------
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

// --- 2. no deep imports across modules (ARCHITECTURE §5) --------------------
const MODULES = readdirSync(SRC, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'core').map((e) => e.name);

for (const f of files) {
  const owner = relative(SRC, f).split('/')[0];
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.\.\/[^'"]+)['"]/g)) {
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
    fail('module-shape', index, 'no showcase() — a module without one cannot pass its gauntlet (§6)');
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
