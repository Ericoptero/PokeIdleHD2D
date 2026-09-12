#!/usr/bin/env node
/**
 * Builds the `structures` tileset out of the buildings we author ourselves.
 *
 * No PDSMS tileset contains a Pokemon Center, a Mart, or any complete building
 *, so those are modelled here and shipped in exactly the same pack shape a
 * .pdsts produces. That means `tiles.load('structures')` needs no new code and a map author
 * places a Pokemon Center with the same call that places a tree:
 *
 *   tiles.find('structures', { category: 'building', name: 'pokemon_center' })
 *
 * Source art lives in assets/structures/<name>/ as <name>.obj + <name>.mtl + *.png, plus a
 * meta.json giving the footprint, collision and door cell. Output goes to
 * public/generated/tiles/structures/.
 *
 * The same code builds the adapted props: they are authored art in exactly
 * the same folder shape, so they are a source directory and a slug, not a second builder.
 *
 *   node tools/assets/build-structures.js
 *   node tools/assets/build-structures.js --src assets/props --slug props
 */

import { readdirSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseObj } from './obj.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const STRIDE = 11;

function parseArgs(argv) {
  const a = { src: 'assets/structures', slug: 'structures' };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) a[k] = argv[++i];
  }
  return a;
}

const ARGS = parseArgs(process.argv.slice(2));
const SRC = join(REPO, ARGS.src);
const SLUG = ARGS.slug;
const OUT = join(REPO, 'public', 'generated', 'tiles', SLUG);

/** Defaults for a structure that ships no meta.json. */
const DEFAULT_META = {
  category: 'building',
  tags: ['building', 'authored'],
  biomes: ['city'],
  collision: 'block',
  w: 1, h: 1,
  /** cell offset of the entrance within the footprint, or null for no door */
  door: null,
  /** cells that stay walkable despite the footprint being blocked */
  walkable: [],
  /** Y-up already? Blender exports Z-up by default. */
  swapYZ: true,
  scale: 1,
  /** emissive material names that should glow at night */
  emissiveMaterials: [],
};

function build() {
  if (!existsSync(SRC)) {
    console.log(`— no ${SRC}; nothing to build. Author art there first.`);
    return { models: 0 };
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'tex'), { recursive: true });

  const dirs = readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory());
  const materials = [];
  const materialIndex = new Map();
  const models = [];
  const chunks = [];
  let offset = 0;

  const materialId = (name, spec) => {
    if (materialIndex.has(name)) return materialIndex.get(name);
    const id = materials.length;
    materials.push({
      id,
      image: spec?.map ?? null,
      name,
      alpha: Math.round((spec?.alpha ?? 1) * 31),
      translucent: (spec?.alpha ?? 1) < 0.999,
      bothFaces: !!spec?.doubleSided,
      vertexColors: false,
      fog: true,
      tilingU: 1, tilingV: 1,
      emissive: spec?.emissive ?? 0,
      uniformNormals: false,
    });
    materialIndex.set(name, id);
    return id;
  };

  for (const dir of dirs) {
    const name = dir.name;
    const folder = join(SRC, name);
    const objFile = readdirSync(folder).find((f) => f.toLowerCase().endsWith('.obj'));
    if (!objFile) { console.warn(`— ${name}: no .obj, skipped`); continue; }

    const metaPath = join(folder, 'meta.json');
    const meta = { ...DEFAULT_META, ...(existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {}) };

    const parsed = parseObj(join(folder, objFile), { scale: meta.scale, swapYZ: meta.swapYZ });

    for (const png of readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.png'))) {
      copyFileSync(join(folder, png), join(OUT, 'tex', png));
    }

    // Flatten every object in the file into one model: a building is one placeable thing.
    const groups = [];
    for (const obj of parsed.objects) {
      for (const g of obj.groups) {
        if (!g.position.length) continue;
        const spec = parsed.materials.get(g.material);
        const mid = materialId(`${name}:${g.material}`, spec);
        const n = g.position.length / 3;
        const buf = new Float32Array(n * STRIDE);
        for (let i = 0; i < n; i++) {
          const o = i * STRIDE;
          buf[o] = g.position[i * 3]; buf[o + 1] = g.position[i * 3 + 1]; buf[o + 2] = g.position[i * 3 + 2];
          buf[o + 3] = g.normal[i * 3]; buf[o + 4] = g.normal[i * 3 + 1]; buf[o + 5] = g.normal[i * 3 + 2];
          buf[o + 6] = g.uv[i * 2]; buf[o + 7] = g.uv[i * 2 + 1];
          buf[o + 8] = 1; buf[o + 9] = 1; buf[o + 10] = 1;
        }
        const bytes = Buffer.from(buf.buffer);
        groups.push({ material: mid, offset, count: n });
        chunks.push(bytes);
        offset += bytes.length;
      }
    }
    if (!groups.length) { console.warn(`— ${name}: no geometry, skipped`); continue; }

    const b = parsed.bounds;
    models.push({
      id: models.length,
      name,
      category: meta.category,
      subcategory: meta.subcategory ?? meta.category,
      orientation: null,
      tags: [...new Set([...meta.tags, 'authored', 'multicell'])],
      biomes: meta.biomes,
      collision: meta.collision,
      w: meta.w, h: meta.h,
      baseY: +b.min[1].toFixed(4),
      bounds: { min: b.min.map((v) => +v.toFixed(4)), max: b.max.map((v) => +v.toFixed(4)) },
      autotile: null,
      groups,
      globalUv: false,
      uvScale: 0,
      door: meta.door,
      walkable: meta.walkable,
      emissiveMaterials: meta.emissiveMaterials,
    });
    console.log(`✓ ${name.padEnd(20)} ${meta.w}x${meta.h}  ` +
      `${groups.length} groups  ${groups.reduce((a, g) => a + g.count / 3, 0)} tris  ` +
      `h=${(b.max[1] - b.min[1]).toFixed(2)}`);
  }

  const pack = { tileset: SLUG, stride: STRIDE, materials, autotileSets: [], models };
  writeFileSync(join(OUT, 'pack.json'), JSON.stringify(pack));
  writeFileSync(join(OUT, 'pack.bin'), Buffer.concat(chunks));
  writeFileSync(join(OUT, 'catalog.json'), JSON.stringify({
    tileset: SLUG, unitsPerCell: 1, axis: 'y-up, +x east, +z south',
    source: `${ARGS.src} (authored)`,
    materials, models,
  }, null, 1));

  const index = join(REPO, 'public', 'generated', 'tiles', 'index.json');
  if (existsSync(index)) {
    const idx = JSON.parse(readFileSync(index, 'utf8'));
    if (!idx.sets.includes(SLUG)) idx.sets.push(SLUG);
    writeFileSync(index, JSON.stringify(idx, null, 1));
  }
  return { models: models.length, materials: materials.length, bytes: offset };
}

const r = build();
console.log(`${SLUG}: ${r.models} models, ${r.materials ?? 0} materials, ${((r.bytes ?? 0) / 1024).toFixed(0)}KB`);
