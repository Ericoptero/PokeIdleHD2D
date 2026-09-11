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
 *   https://play.pokemonshowdown.com/data/pokedex.json   types / base stats / evolutions,
 *                                                plus the evolution METHOD (`evoLevel`,
 *                                                `evoType`, `evoItem`, `evoCondition`),
 *                                                which Showdown carries on the CHILD and we
 *                                                invert onto the parent. Pokémon Showdown's
 *                                                dex is a single file, covers all nine
 *                                                generations including regional forms, and is
 *                                                fetched exactly once, here, at build time.
 *   PokeAPI data/v2/csv/pokemon_species.csv      capture_rate and growth_rate_id — the two
 *   PokeAPI data/v2/csv/pokemon.csv              base_experience                   fields
 *                                                Showdown does not publish. veekun/pokedex is
 *                                                the same dataset but its master stops at
 *                                                species #898, which drops all of Gen 9
 *                                                including `lechonk` — a live row in
 *                                                src/encounter/tables.js. PokeAPI's copy is
 *                                                current, so it is the one we join against.
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
const POKEAPI = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv';

/**
 * PokeAPI's `growth_rates.csv` ids, spelled out rather than parsed.
 *
 * The CSV's third column is a LaTeX formula containing quoted embedded newlines, so parsing
 * that file to recover six names nobody disputes would be six ways to get it wrong. The
 * names are the mainline ones; `slow-then-very-fast` and `fast-then-very-slow` are
 * PokeAPI's spellings of what the games call *erratic* and *fluctuating*.
 */
const GROWTH_RATES = ['', 'slow', 'medium', 'fast', 'medium-slow', 'erratic', 'fluctuating'];

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

/**
 * Fetches once, then never again. Every remote input lands in `node_modules/.cache/` so a
 * rebuild is offline and byte-stable — which is the only reason this script can claim to be
 * deterministic while reading the internet.
 */
async function cached(url, name) {
  const file = join(REPO, 'node_modules', '.cache', name);
  if (existsSync(file)) {
    console.log(`${name}: cache hit`);
    return readFileSync(file, 'utf8');
  }
  console.log(`${name}: fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return text;
}

const loadDex = async () => JSON.parse(await cached(DEX_URL, 'pokedex.json'));

/**
 * Reads one PokeAPI CSV into rows keyed by header name.
 *
 * Deliberately not a general CSV parser: these two files have no quoted fields and no
 * embedded commas in any column we read (`growth_rates.csv`, which does, is the reason
 * GROWTH_RATES is a literal above). A split is therefore correct here and a parser would be
 * more code for the same answer — but the header count is asserted per row so the day PokeAPI
 * adds a quoted column, this fails loudly instead of silently shifting every field left.
 */
async function loadCsv(name) {
  const text = await cached(`${POKEAPI}/${name}`, `pokeapi-${name}`);
  const lines = text.split('\n').filter((l) => l.trim().length);
  const head = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length !== head.length) throw new Error(`${name}: line ${i + 1} has ${cells.length} cells, expected ${head.length} — the file has grown a quoted column`);
    const row = {};
    for (let c = 0; c < head.length; c++) row[head[c]] = cells[c];
    rows.push(row);
  }
  return rows;
}

/**
 * Showdown records an evolution on the CHILD (`ivysaur.evoLevel = 16`), because that is
 * where the *requirement to exist* belongs. The game asks the opposite question — "this
 * Pokemon just levelled, does it become something?" — so the requirement is inverted here,
 * once, at build time, onto the parent's own `evo` list. `evolves` keeps its plain
 * string[] shape beside it; nothing reads it yet and a rename would be churn.
 */
function evoRequirements(dex, entry) {
  const out = [];
  for (const childName of entry.evos ?? []) {
    const child = dex[slugKey(childName)];
    if (!child) continue;
    out.push({
      to: toSlug(childName),
      level: Number.isFinite(child.evoLevel) ? child.evoLevel : null,
      // 'levelUp' is Showdown's absent default: a bare evoLevel and nothing else.
      type: child.evoType ?? (Number.isFinite(child.evoLevel) ? 'levelUp' : null),
      item: child.evoItem ? toSlug(child.evoItem).replace(/-/g, '') : null,
      cond: child.evoCondition ?? null,
    });
  }
  out.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return out;
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

  // capture_rate + growth_rate_id are keyed by SPECIES (one row per base species);
  // base_experience is keyed by POKEMON (one row per form). Index both by identifier and by
  // id, because our folder slugs cover forms Showdown folds onto a base entry and the dex
  // number is what survives that fold.
  const speciesCsv = await loadCsv('pokemon_species.csv');
  const pokemonCsv = await loadCsv('pokemon.csv');
  const csvBySlug = new Map(speciesCsv.map((r) => [r.identifier, r]));
  const csvById = new Map(speciesCsv.map((r) => [Number(r.id), r]));
  const expBySlug = new Map(pokemonCsv.map((r) => [r.identifier, Number(r.base_experience) || 0]));
  const expBySpecies = new Map();
  for (const r of pokemonCsv) {
    // is_default picks the form the games treat as the species' own.
    if (r.is_default === '1') expBySpecies.set(Number(r.species_id), Number(r.base_experience) || 0);
  }

  /** capture_rate / growth_rate, by slug first and by dex number second. */
  const statsFor = (slug, id) => csvBySlug.get(slug) ?? csvById.get(id) ?? null;

  let bySlugHits = 0, byIdHits = 0;
  const noCsv = [];

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
    const bst = Object.values(e.baseStats ?? {}).reduce((a, b) => a + b, 0);

    const csv = statsFor(slug, dexNum);
    if (!csv) noCsv.push(slug);
    else if (csvBySlug.has(slug)) bySlugHits++;
    else byIdHits++;
    out.push({
      id: dexNum,
      name: slug,
      display: e.name,
      base: toSlug(baseDisplay),
      form: e.forme ?? (slug === toSlug(baseDisplay) ? null : slug.slice(toSlug(baseDisplay).length + 1)),
      gen: e.gen ?? genOf(dexNum),
      types: (e.types ?? []).map((t) => t.toLowerCase()),
      baseStats: e.baseStats ?? { hp: 50, atk: 50, def: 50, spa: 50, spd: 50, spe: 50 },
      bst,
      evolves: (e.evos ?? []).map(toSlug),
      prevo: e.prevo ? toSlug(e.prevo) : null,
      heightM: e.heightm ?? 1,
      weightKg: e.weightkg ?? 1,
      color: (e.color ?? 'gray').toLowerCase(),

      // --- the three fields Showdown does not publish, and the inverted evolution ---
      // `catchRate` is the mainline capture rate (3..255). It replaces the two independent
      // BST-derived proxies the tree grew while this was missing (encounter/rolls.js and
      // automation/fields.js both declared one, character for character the same curve).
      catchRate: csv ? Number(csv.capture_rate) || 45 : 45,
      growthRate: csv ? (GROWTH_RATES[Number(csv.growth_rate_id)] ?? 'medium') : 'medium',
      baseExp: expBySlug.get(slug) ?? expBySpecies.get(dexNum) ?? Math.round(bst * 0.35),
      evo: evoRequirements(dex, e),
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
  console.log(`  capture/growth join: ${bySlugHits} by slug, ${byIdHits} by dex id, ${noCsv.length} unmatched`);
  if (noCsv.length) console.log(`  NO CSV ROW (${noCsv.length}): ${noCsv.slice(0, 12).join(', ')}`);
  console.log(`  evolution requirements inverted onto ${out.filter((x) => x.evo.length).length} parents`);
  if (unmatched.length) console.log(`  UNMATCHED (${unmatched.length}): ${unmatched.join(', ')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
