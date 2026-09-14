#!/usr/bin/env node
/**
 * migrate-v2.js — one-time transform of the six shipped `.map.json` files (v1 -> v2).
 *
 *   node tools/mapstudio/migrate-v2.js [--dir public/maps] [--dry]
 *
 * Pure JSON transform, no browser: v1 files already carry everything a v2 map needs (grid,
 * layers, extras, spawn, markers, npcs, links, lights, cameras, formation) except the fields
 * this refactor restructures. Per file:
 *
 *   - drop `biome`, `source`, `encounters`
 *   - `wild.resolved.slots[]` -> `spawnPoints[]`: each slot keeps its `cx`/`cz`/`dir`, gets a
 *     stable `id`, a `respawnSeconds` (26 — the old global `RESPAWN_S`), and every species the
 *     map's old shared `encounters.table` could roll (any slot could produce any species from
 *     that table, weighted, both at initial spawn and at every refill — so every migrated spawn
 *     point gets the table's full row list, not a subset, to keep the migrated distribution
 *     equivalent to what the game already produced).
 *   - `economy`: the old per-biome yield profile (`idle/accrual.js`'s retired `BIOMES` table),
 *     keyed by the same `encounters.table` id.
 *
 * The row/profile data below is copied verbatim from the tables this refactor retires
 * (`src/encounter/tables.js`'s `TABLES`, `src/idle/accrual.js`'s `BIOMES`) — this script is
 * their only remaining home once those files are simplified.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeMapFile } from '../../src/terrain/mapfile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const R = (n, w, r, when = 'any', bump = 0) => ({ name: n, chance: w, when, bump });

/** `src/encounter/tables.js`'s retired `TABLES`, species/weight/when/bump only (capture rate
 *  now comes from `public/generated/species.json` directly — see `encounter/drops.js`/
 *  `tables.js`'s own simplification). */
const SPECIES_BY_TABLE = {
  city: [],
  meadow: [
    R('patrat', 18, 255, 'day'), R('lillipup', 16, 255, 'day'), R('sentret', 12, 255, 'morning'),
    R('starly', 14, 255, 'morning'), R('bunnelby', 12, 255, 'day'), R('skwovet', 10, 255, 'day'),
    R('lechonk', 10, 255, 'day'), R('buneary', 6, 190, 'morning'), R('minccino', 5, 255, 'day'),
    R('audino', 4, 255, 'day'), R('deerling', 8, 190, 'day'),
    R('pidgey', 12, 255, 'any'), R('rattata', 12, 255, 'any'), R('oddish', 10, 255, 'any'),
    R('hoppip', 8, 255, 'any'), R('cottonee', 8, 190, 'any'), R('petilil', 8, 190, 'any'),
    R('sunkern', 6, 235, 'any'), R('marill', 6, 190, 'any'), R('wooper', 6, 255, 'any'),
    R('azurill', 5, 150, 'any'),
    R('hoothoot', 18, 255, 'night'), R('purrloin', 14, 255, 'night'), R('poochyena', 14, 255, 'night'),
    R('munna', 8, 190, 'night'), R('drowzee', 6, 190, 'night'), R('zubat', 12, 255, 'night'),
    R('murkrow', 6, 30, 'night'), R('misdreavus', 4, 45, 'night', 2), R('clefairy', 4, 150, 'night', 1),
    R('eevee', 2, 45, 'any', 2),
  ],
  forest: [
    R('caterpie', 18, 255, 'day'), R('weedle', 16, 255, 'day'), R('sewaddle', 14, 255, 'day'),
    R('kricketot', 12, 255, 'morning'), R('shroomish', 10, 255, 'day'), R('seedot', 10, 255, 'day'),
    R('deerling', 10, 190, 'day'), R('paras', 8, 190, 'day'), R('pansage', 6, 190, 'day'),
    R('foongus', 8, 190, 'day'), R('applin', 4, 255, 'day', 1),
    R('oddish', 12, 255, 'any'), R('bellsprout', 12, 255, 'any'), R('budew', 8, 255, 'any'),
    R('cherubi', 8, 190, 'any'), R('combee', 6, 120, 'any'), R('sunkern', 6, 235, 'any'),
    R('ferroseed', 4, 255, 'any'), R('larvesta', 1, 45, 'any', 4),
    R('venonat', 14, 190, 'night'), R('spinarak', 12, 255, 'night'), R('hoothoot', 14, 255, 'night'),
    R('pineco', 8, 190, 'night'), R('gastly', 6, 190, 'night'), R('joltik', 10, 190, 'night'),
    R('woobat', 10, 190, 'night'), R('phantump', 4, 120, 'night', 2),
  ],
  cave: [
    R('zubat', 22, 255, 'any'), R('geodude', 18, 255, 'any'), R('roggenrola', 16, 255, 'any'),
    R('woobat', 14, 190, 'any'), R('sandshrew', 10, 255, 'any'), R('diglett', 10, 255, 'any'),
    R('machop', 8, 180, 'any'), R('aron', 8, 180, 'any'), R('dwebble', 8, 190, 'any'),
    R('drilbur', 8, 120, 'any'), R('nosepass', 5, 255, 'any'), R('rockruff', 6, 190, 'morning'),
    R('onix', 4, 45, 'any', 2), R('carbink', 2, 60, 'any', 3),
    R('axew', 2, 75, 'any', 3), R('gible', 1, 45, 'any', 4), R('larvitar', 1, 45, 'any', 4),
    R('golbat', 8, 90, 'night', 3), R('gastly', 10, 190, 'night'), R('litwick', 6, 190, 'night'),
    R('yamask', 5, 190, 'night'), R('sableye', 3, 45, 'night', 2),
  ],
  coast: [
    R('wingull', 20, 190, 'day'), R('krabby', 14, 225, 'day'), R('tentacool', 14, 190, 'day'),
    R('staryu', 8, 225, 'day'), R('shellder', 10, 190, 'day'), R('corphish', 10, 205, 'day'),
    R('buizel', 10, 190, 'day'), R('finneon', 8, 190, 'morning'), R('spheal', 6, 255, 'morning'),
    R('wailmer', 5, 125, 'day', 2), R('mantyke', 2, 25, 'day', 2),
    R('magikarp', 14, 255, 'any'), R('psyduck', 10, 190, 'any'), R('marill', 8, 190, 'any'),
    R('wooper', 8, 255, 'any'), R('shellos', 8, 190, 'any'), R('alomomola', 3, 75, 'any', 2),
    R('feebas', 1, 255, 'any'),
    R('chinchou', 12, 190, 'night'), R('remoraid', 10, 190, 'night'), R('frillish', 8, 190, 'night'),
    R('luvdisc', 6, 225, 'night'), R('dratini', 1, 45, 'night', 4),
  ],
};

/** `src/idle/accrual.js`'s retired `BIOMES` yield-multiplier table. */
const ECONOMY_BY_TABLE = {
  city: { money: 1.55, exp: 0.55, research: 0.80, encounters: 0.35, favours: { normal: 1.20, electric: 1.30, steel: 1.12, psychic: 1.15 } },
  meadow: { money: 1.00, exp: 1.00, research: 1.00, encounters: 1.00, favours: { normal: 1.18, fairy: 1.28, grass: 1.15, flying: 1.12 } },
  forest: { money: 0.85, exp: 1.45, research: 1.20, encounters: 1.35, favours: { grass: 1.38, bug: 1.32, poison: 1.14, dark: 1.08 } },
  cave: { money: 0.70, exp: 1.20, research: 1.75, encounters: 1.60, favours: { rock: 1.42, ground: 1.36, steel: 1.22, dark: 1.18 } },
  coast: { money: 1.15, exp: 1.05, research: 1.30, encounters: 1.15, favours: { water: 1.40, flying: 1.22, ice: 1.15, fighting: 1.06 } },
};

const DEFAULT_RESPAWN_S = 26;

function migrate(map) {
  // `demo-city`/`pokecenter` never wrote `encounters.table` into their own file — the runtime
  // named it in code instead (`terrain.setDefaultProfile({encounterTable:'city'})`,
  // `city/index.js`/`pokecenter/index.js`). Fall back the same way here: `city`/`interior`
  // maps default to the `city` profile (no wildlife, the richer money/lower research mix),
  // everything else to `meadow`.
  const fallback = map.kind === 'city' || map.kind === 'interior' ? 'city' : 'meadow';
  const tableId = map.encounters?.table ?? fallback;
  const species = SPECIES_BY_TABLE[tableId] ?? [];
  const slots = map.wild?.resolved?.slots ?? [];

  const spawnPoints = slots.map((s, i) => ({
    id: `spawn-${i}`,
    cx: s.cx, cz: s.cz, dir: s.dir ?? 0,
    respawnSeconds: DEFAULT_RESPAWN_S,
    species: species.map((r) => ({ ...r })),
  }));

  const { biome: _biome, source: _source, encounters: _encounters, wild: _wild, ...rest } = map;
  return {
    ...rest,
    version: 2,
    economy: ECONOMY_BY_TABLE[tableId] ?? ECONOMY_BY_TABLE.meadow,
    spawnPoints,
  };
}

function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const dir = join(ROOT, dirIdx >= 0 ? args[dirIdx + 1] : 'public/maps');
  const dry = args.includes('--dry');

  const files = readdirSync(dir).filter((f) => f.endsWith('.map.json'));
  for (const f of files) {
    const path = join(dir, f);
    const map = JSON.parse(readFileSync(path, 'utf8'));
    if (map.version === 2) { console.log(`skip  ${f} (already v2)`); continue; }
    const migrated = migrate(map);
    const fallback = map.kind === 'city' || map.kind === 'interior' ? 'city' : 'meadow';
    console.log(`${dry ? 'would migrate' : 'migrate'}  ${f} — ${migrated.spawnPoints.length} spawn points, `
      + `economy from "${map.encounters?.table ?? fallback}"`);
    if (!dry) {
      // Reuse the project's own pretty-printer (`mapfile.js`) so the output stays
      // diff-friendly, matching every other `.map.json` in the repo — a plain
      // `JSON.stringify` would explode every RLE run array into one line per pair.
      writeFileSync(path, serializeMapFile(migrated), 'utf8');
    }
  }
}

main();
