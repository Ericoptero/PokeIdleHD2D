#!/usr/bin/env node
/**
 * Sorts every prop-like model in the converted tilesets into the three things it can be,
 * so the Blender adaptation pass (brief: "adapt they to be similar to [AdAstra]") works from
 * measurements instead of from names.
 *
 * The distinction the brief is pointing at is visible in the triangle counts. AdAstra builds
 * a prop as real geometry — `bench_s` is 18 triangles, `lamp_h` is 30 — and builds a tree as
 * an upright *cross* of two billboards (8-10 triangles). Every other tileset draws the same
 * kind of object as a single quad leaning back at 45 degrees: `barrel` is 2 triangles
 * spanning both Y and Z, `pile_of_logs` is 2, `axe` is 2. Those read correctly only from the
 * one angle they were drawn for, they self-shadow wrongly, and they visibly shear when
 * anything passes behind them.
 *
 * Classes:
 *   decal    - one horizontal quad lying on the ground (little_rocks). Correct as-is.
 *   tilted   - one or two quads leaning in Y *and* Z. This is what needs rebuilding.
 *   cross    - two or more upright quads that already intersect. Correct as-is.
 *   solid    - enough triangles, mixed face orientations: already real geometry.
 *
 *   node tools/props/analyze.js            # summary
 *   node tools/props/analyze.js --json     # the work list for the Blender pass
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TILES = join(REPO, 'public', 'generated', 'tiles');

/** Categories that describe a discrete object standing in a cell, as opposed to terrain. */
const PROPISH = new Set(['prop', 'plant', 'tree', 'light', 'sign', 'bench']);
const STRIDE = 11;   // pos3 nrm3 uv2 col3

/** Reads a model's vertices (position + normal) straight out of pack.bin. */
function verticesOf(model, bin) {
  const out = [];
  for (const g of model.groups ?? []) {
    for (let i = 0; i < g.count; i++) {
      // `offset` is a *byte* offset — it is fed straight to `new Float32Array(bin, offset, ..)`
      // in src/tiles/index.js — while `count` is a vertex count.
      const b = g.offset + i * STRIDE * 4;
      out.push({
        p: [bin.readFloatLE(b), bin.readFloatLE(b + 4), bin.readFloatLE(b + 8)],
        n: [bin.readFloatLE(b + 12), bin.readFloatLE(b + 16), bin.readFloatLE(b + 20)],
      });
    }
  }
  return out;
}

/**
 * How far the model departs from a single flat sheet. A leaning sprite is one plane and
 * scores ~0; a cliff bank climbs in steps and scores a fifth of a cell or more.
 *
 * The plane is fitted from the *average normal* through the centroid, which is stable for
 * the two- and four-triangle models this has to separate.
 */
function planarity(verts) {
  const n = [0, 0, 0], c = [0, 0, 0];
  for (const v of verts) {
    for (let k = 0; k < 3; k++) { n[k] += v.n[k]; c[k] += v.p[k]; }
  }
  const len = Math.hypot(...n);
  if (!len) return Infinity;
  for (let k = 0; k < 3; k++) { n[k] /= len; c[k] /= verts.length; }
  let worst = 0;
  for (const v of verts) {
    const d = Math.abs((v.p[0] - c[0]) * n[0] + (v.p[1] - c[1]) * n[1] + (v.p[2] - c[2]) * n[2]);
    if (d > worst) worst = d;
  }
  return worst;
}

export function classify(model, bin) {
  const tris = model.tris ?? 0;
  const b = model.bounds;
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  const dx = b.max[0] - b.min[0];

  const verts = verticesOf(model, bin);
  let flat = 0, upright = 0, tilted = 0;
  for (const v of verts) {
    const ny = Math.abs(v.n[1]);
    if (ny > 0.95) flat++;
    else if (ny < 0.15) upright++;
    else tilted++;
  }
  const n = verts.length || 1;
  const flatness = planarity(verts);

  // One horizontal quad on the ground is a decal and is exactly right as it is.
  if (tris <= 2 && dy < 0.08) return { klass: 'decal', tris, dy, dz, flatness, why: 'one horizontal quad' };

  // A leaning *sprite* is a single flat sheet: every vertex sits on one plane and that plane
  // is tilted. A cliff bank also has tilted normals, but it climbs in steps and so is not
  // planar — that is the only thing that reliably separates `barrel` from `rock_edge_n`,
  // which the triangle count alone gets wrong.
  if (tilted / n > 0.5 && flatness < 0.02) {
    return { klass: 'tilted', tris, dy, dz, flatness,
      why: `one plane leaning ${Math.round(Math.atan2(dy, dz) * 180 / Math.PI)} degrees` };
  }
  if (tilted / n > 0.5) {
    return { klass: 'slope', tris, dy, dz, flatness, why: `tilted but not planar (${flatness.toFixed(2)}) — terrain, not a sprite` };
  }

  // Real geometry: enough triangles, and it uses more than one face orientation.
  if (tris >= 8 && flat > 0 && upright > 0) {
    return { klass: 'solid', tris, dy, dz, flatness, why: `${tris} tris, ${flat} flat + ${upright} upright verts` };
  }

  // A cross-billboard: everything upright, occupying both horizontal axes.
  if (upright / n > 0.9 && dx > 0.5 && dz > 0.5 && tris >= 4) {
    return { klass: 'cross', tris, dy, dz, flatness, why: 'upright quads crossing in X and Z' };
  }
  if (upright / n > 0.9) {
    return { klass: 'plane', tris, dy, dz, flatness, why: 'upright, but facing one way only' };
  }

  return { klass: 'solid', tris, dy, dz, flatness, why: 'mixed orientations' };
}

export function analyze() {
  // Scan the directory rather than index.json: the index lists whatever the last build touched,
  // and every tileset ever converted is still on disk and still a source of props.
  const slugs = readdirSync(TILES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'structures')
    .map((e) => e.name).sort();
  const out = [];
  for (const slug of slugs) {
    const catPath = join(TILES, slug, 'catalog.json');
    if (!existsSync(catPath)) continue;
    const cat = JSON.parse(readFileSync(catPath, 'utf8'));
    const bin = readFileSync(join(TILES, slug, 'pack.bin'));
    for (const m of cat.models) {
      if (!PROPISH.has(m.category)) continue;
      const c = classify(m, bin);
      out.push({
        slug, id: m.id, name: m.name, category: m.category, subcategory: m.subcategory ?? null,
        obj: m.obj, w: m.w, h: m.h, materials: m.materials, tags: m.tags ?? [],
        bounds: m.bounds, ...c,
      });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = analyze();
  if (process.argv.includes('--json')) {
    const work = rows.filter((r) => r.klass === 'tilted' && r.slug !== 'bw2-adastra');
    writeFileSync(join(REPO, 'tools', 'props', 'worklist.json'),
      JSON.stringify({ total: rows.length, needsRebuild: work.length, models: work }, null, 1));
    console.log(`${work.length} of ${rows.length} prop-like models need rebuilding -> tools/props/worklist.json`);
    process.exit(0);
  }

  const bySlug = new Map();
  for (const r of rows) {
    const t = bySlug.get(r.slug) ?? { decal: 0, tilted: 0, plane: 0, cross: 0, slope: 0, solid: 0 };
    t[r.klass]++;
    bySlug.set(r.slug, t);
  }
  const cols = ['decal', 'tilted', 'plane', 'cross', 'slope', 'solid'];
  console.log(`tileset              ${cols.map((c) => c.padStart(6)).join('')}`);
  for (const [slug, t] of [...bySlug].sort()) {
    const mark = slug === 'bw2-adastra' ? '   <- the reference style' : '';
    console.log(`${slug.padEnd(20)} ${cols.map((c) => String(t[c]).padStart(6)).join('')}${mark}`);
  }
  const tilted = rows.filter((r) => r.klass === 'tilted' && r.slug !== 'bw2-adastra');
  console.log(`\n${tilted.length} models lean at 45 degrees and need a Blender rebuild. Sample:`);
  for (const r of tilted.slice(0, 12)) {
    console.log(`  ${r.slug}/${r.name.padEnd(22)} ${String(r.tris).padStart(2)} tris  ${r.why}`);
  }
}
