#!/usr/bin/env node
/**
 * Build `public/generated/species.json` — the committed Gen 1-9 species snapshot
 * (ARCHITECTURE §5.5: "Species data is a committed snapshot; nothing is fetched at
 * runtime").
 *
 *   node src/pokemon/tools/build-species.js
 *
 * This is a BUILD-TIME Node script. It lives under src/pokemon/ because that is the folder
 * the `pokemon` builder owns; it is never imported by the browser bundle and never runs in
 * the game. Nothing in src/pokemon/*.js imports it.
 *
 * Inputs
 *   assets/overworld/<slug>/{normal,shiny}.png   the 1253 sheets we actually ship — the
 *                                                folder list *is* the species list, and the
 *                                                PNG header gives the real frame size
 *                                                (32 px for 1192 of them, 64 px for 61).
 *   https://play.pokemonshowdown.com/data/pokedex.json   types / base stats / evolutions.
 *                                                Pokémon Showdown's dex is a single file,
 *                                                covers all nine generations including
 *                                                regional forms, and is fetched exactly
 *                                                once, here, at build time.
 *
 * Output is deterministic: entries are sorted by (dex, form order, slug), so re-running
 * the script on the same inputs produces byte-identical JSON.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OVERWORLD = join(REPO, 'assets', 'overworld');
const OUT = join(REPO, 'public', 'generated', 'species.json');
const DEX_URL = 'https://play.pokemonshowdown.com/data/pokedex.json';
const CACHE = join(REPO, 'node_modules', '.cache', 'pokedex.json');

/** Folder slugs whose Showdown key is not just the slug with the dashes removed. */
const ALIASES = {
  'arceus-fight': 'arceusfighting',
  'arceus-fly': 'arceusflying',
  'basculegion-female': 'basculegionf',
  'basculin-blue-stripe': 'basculin',              // Showdown's base Basculin is blue-striped
  'basculin-white-stripe': 'basculinwhitestriped',
  'calyrex-ice-rider': 'calyrexice',
  'calyrex-shadow-rider': 'calyrexshadow',
  'darmanitan-zen-mode': 'darmanitanzen',
  'indeedee-female': 'indeedeef',
  'magearna-original-color': 'magearnaoriginal',
  'meowstic-female': 'meowsticf',
  'oinkologne-female': 'oinkolognef',
  'oricorio-psu': 'oricoriopau',
  'pikachu-alola-cap': 'pikachualola',
  'pikachu-hoenn-cap': 'pikachuhoenn',
  'pikachu-kalos-cap': 'pikachukalos',
  'pikachu-original-cap': 'pikachuoriginal',
  'pikachu-partner-cap': 'pikachupartner',
  'pikachu-sinnoh-cap': 'pikachusinnoh',
  'pikachu-unova-cap': 'pikachuunova',
  'pikachu-world-cap': 'pikachuworld',
  'rotom-fridge': 'rotomfrost',
  'rotom-lawn-mower': 'rotommow',
  'wooper-paldean': 'wooperpaldea',
};

/** National-dex ranges per generation. */
const GEN_MAX = [151, 251, 386, 493, 649, 721, 809, 905, 1025];

const slugKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const toSlug = (display) => display.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function genOf(num) {
  for (let i = 0; i < GEN_MAX.length; i++) if (num <= GEN_MAX[i]) return i + 1;
  return 9;
}

/** Reads the width/height out of a PNG's IHDR without decoding a single pixel. */
function pngSize(file) {
  const buf = readFileSync(file, { length: 33 });
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`not a png: ${file}`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function loadDex() {
  if (existsSync(CACHE)) {
    console.log(`pokedex: cache hit (${CACHE})`);
    return JSON.parse(readFileSync(CACHE, 'utf8'));
  }
  console.log(`pokedex: fetching ${DEX_URL}`);
  const res = await fetch(DEX_URL);
  if (!res.ok) throw new Error(`pokedex: ${res.status} ${res.statusText}`);
  const text = await res.text();
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, text);
  return JSON.parse(text);
}

/**
 * Cosmetic forms (Unown's 28 letters, Vivillon's patterns, Furfrou's trims) have their own
 * sprite folder but no separate dex entry. Drop one dash-separated segment at a time until
 * something matches, so `alcremie-berry-sweet` lands on `alcremie` and keeps real stats
 * instead of being thrown away.
 */
function resolve(dex, slug) {
  // Showdown also carries stub entries for purely cosmetic formes (`vivillonarchipelago`,
  // `deerlingsummer`): num 0, no types, no stats. Matching one of those would produce a
  // species with no data at all, so a stub is treated as a miss and the walk continues.
  const usable = (e) => e && e.num > 0 && (e.types?.length ?? 0) > 0;
  const alias = ALIASES[slug];
  if (usable(dex[alias])) return { entry: dex[alias], via: 'alias' };
  const parts = slug.split('-');
  for (let n = parts.length; n >= 1; n--) {
    const key = slugKey(parts.slice(0, n).join('-'));
    if (usable(dex[key])) return { entry: dex[key], via: n === parts.length ? 'exact' : 'base' };
  }
  return null;
}

async function main() {
  const dex = await loadDex();

  const folders = readdirSync(OVERWORLD, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const out = [];
  const unmatched = [];
  const approx = [];

  for (const slug of folders) {
    const normal = join(OVERWORLD, slug, 'normal.png');
    const shiny = join(OVERWORLD, slug, 'shiny.png');
    if (!existsSync(normal)) { unmatched.push(`${slug} (no normal.png)`); continue; }

    const size = pngSize(normal);
    const frame = size.w / 2;                       // 2 columns x 4 rows, always
    if (size.h !== frame * 4) throw new Error(`${slug}: ${size.w}x${size.h} is not 2 cols x 4 rows`);

    const hit = resolve(dex, slug);
    if (!hit) { unmatched.push(slug); continue; }
    if (hit.via !== 'exact') approx.push(`${slug} -> ${hit.entry.name}`);
    const e = hit.entry;

    const baseDisplay = e.baseSpecies ?? e.name;
    const dexNum = e.num > 0 ? e.num : 0;
    out.push({
      id: dexNum,
      name: slug,
      display: e.name,
      base: toSlug(baseDisplay),
      form: e.forme ?? (slug === toSlug(baseDisplay) ? null : slug.slice(toSlug(baseDisplay).length + 1)),
      gen: e.gen ?? genOf(dexNum),
      types: (e.types ?? []).map((t) => t.toLowerCase()),
      baseStats: e.baseStats ?? { hp: 50, atk: 50, def: 50, spa: 50, spd: 50, spe: 50 },
      bst: Object.values(e.baseStats ?? {}).reduce((a, b) => a + b, 0),
      evolves: (e.evos ?? []).map(toSlug),
      prevo: e.prevo ? toSlug(e.prevo) : null,
      heightM: e.heightm ?? 1,
      weightKg: e.weightkg ?? 1,
      color: (e.color ?? 'gray').toLowerCase(),
      // The sprite sheet as shipped: 2 columns (walk cycle) x 4 rows (north/west/south/east).
      sheet: { w: size.w, h: size.h, frame, shiny: existsSync(shiny) },
    });
  }

  out.sort((a, b) => (a.id - b.id) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const byGen = {};
  for (const s of out) byGen[s.gen] = (byGen[s.gen] ?? 0) + 1;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  const kb = (statSync(OUT).size / 1024).toFixed(0);

  console.log(`species.json: ${out.length} entries, ${kb} KB`);
  console.log(`  per generation: ${Object.entries(byGen).map(([g, n]) => `g${g}:${n}`).join(' ')}`);
  console.log(`  64px sheets: ${out.filter((s) => s.sheet.frame === 64).length}`);
  console.log(`  cosmetic forms folded onto their base entry: ${approx.length}`);
  if (unmatched.length) console.log(`  UNMATCHED (${unmatched.length}): ${unmatched.join(', ')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
