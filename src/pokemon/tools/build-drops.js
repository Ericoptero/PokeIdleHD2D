#!/usr/bin/env node
/**
 * Build `public/generated/drops.json` — one drop table per species, computed once and
 * committed (`src/encounter/drops.js`: "each Pokémon species defines its own individual
 * drops globally on the project").
 *
 *   node src/pokemon/tools/build-drops.js
 *
 * This is a BUILD-TIME Node script, never imported by the browser bundle. It reads the
 * already-built `public/generated/species.json` (types, capture rate, BST) and derives each
 * species' table from the same formula `src/encounter/drops.js` used to compute live, keyed
 * by a biome, before every map got its own authored wildlife: type family, capture-rate rung,
 * base-stat-total stature bonus. What is different now is that the derivation runs once,
 * here, instead of on every roll — a species' drops no longer depend on *where* it was
 * caught, only on what it is.
 *
 * Output: `{ [speciesName]: {id, min, max, chance}[] }`, at most 3 rows per species.
 * Re-run whenever `species.json` changes (a new species, a corrected capture rate).
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SPECIES_IN = join(ROOT, 'public', 'generated', 'species.json');
const OUT = join(ROOT, 'public', 'generated', 'drops.json');

/** The twelve treasure items (`economy/items.js`), four families of three. Mirrored from
 *  `src/pokemon/evolution.js` — see that file's own header and `tools/seams/run.js` rule 7. */
export const MATERIAL_FAMILIES = {
  mushroom: ['tinymushroom', 'bigmushroom', 'balmmushroom'],
  pearl: ['pearl', 'bigpearl', 'pearlstring'],
  star: ['stardust', 'starpiece', 'cometshard'],
  mineral: ['nugget', 'rarebone', 'bignugget'],
};

export const FAMILY_BY_TYPE = {
  grass: 'mushroom', bug: 'mushroom', poison: 'mushroom', fighting: 'mushroom',
  water: 'pearl', ice: 'pearl', flying: 'pearl',
  psychic: 'star', fairy: 'star', ghost: 'star', dark: 'star', dragon: 'star',
  fire: 'mineral', electric: 'mineral', steel: 'mineral',
  normal: 'mineral', rock: 'mineral', ground: 'mineral',
};

const familyFor = (type) => FAMILY_BY_TYPE[String(type ?? '').toLowerCase()] ?? 'mineral';

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/** Which rung of a family's ladder a species draws from — the capture rate, because that is
 *  the one number that already means "how unusual is this". */
function rungFor(catchRate) {
  const r = Number(catchRate) || 255;
  if (r <= 60) return 2;
  if (r <= 150) return 1;
  return 0;
}

/**
 * Per-row odds. Rebalanced from the old three-row (place + own-type + second-type) formula
 * now that there is no "place" row to carry most of the aggregate: `1 - (1-0.34)(1-0.20) =
 * 0.472`, in the same ~0.45–0.47 band the old three-row table targeted
 * (`src/encounter/drops.js`'s retired `DROP_CHANCE` note).
 */
const OWN_TYPE_CHANCE = 0.34;
const SECOND_TYPE_CHANCE = 0.20;
const STATURE_MIN = 0.03;
const STATURE_MAX = 0.10;
const STATURE_BST = 480;

function tableFor(species) {
  const types = (species.types ?? ['normal']).map((t) => String(t).toLowerCase());
  const rung = rungFor(species.catchRate);
  const own = MATERIAL_FAMILIES[familyFor(types[0])];
  const second = MATERIAL_FAMILIES[familyFor(types[1] ?? types[0])];

  const rows = [
    { id: own[rung], min: 1, max: 1, chance: OWN_TYPE_CHANCE },
    { id: second[clamp(rung - 1, 0, second.length - 1)], min: 1, max: 1, chance: SECOND_TYPE_CHANCE },
  ];
  // Something substantial is occasionally worth going back for — its own family's best rung,
  // scaled by base-stat total.
  if (species.bst >= STATURE_BST) {
    rows.push({
      id: own[own.length - 1], min: 1, max: 1,
      chance: clamp(STATURE_MIN + (species.bst - STATURE_BST) / 6000, STATURE_MIN, STATURE_MAX),
    });
  }
  return rows;
}

function main() {
  const species = JSON.parse(readFileSync(SPECIES_IN, 'utf8'));
  const out = {};
  for (const s of species) out[s.name] = tableFor(s);
  writeFileSync(OUT, JSON.stringify(out));
  const kb = (statSync(OUT).size / 1024).toFixed(0);
  console.log(`drops.json: ${Object.keys(out).length} species, ${kb} KB`);
}

// Guarded so `tools/seams/run.js`'s drop-mirror check (rule 7) can `import()` this file for
// its `MATERIAL_FAMILIES`/`FAMILY_BY_TYPE` exports without re-running the build as a side
// effect — only `node src/pokemon/tools/build-drops.js` directly does that.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
