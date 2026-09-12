#!/usr/bin/env node
/**
 * Build `public/generated/moves.json` and `public/generated/learnsets.json` — the committed
 * battle-data snapshot (src/battle/index.js; nothing is fetched at runtime).
 *
 *   node src/pokemon/tools/build-battle-data.js
 *
 * A BUILD-TIME Node script, like its sibling `build-species.js`. It lives under src/pokemon/
 * because that is where the species pipeline already lives; it is never imported by the
 * browser bundle and nothing in src/ imports it.
 *
 * Inputs
 *   public/generated/species.json                        the species we actually ship — the
 *                                                        list IS the trim. Run build-species
 *                                                        first.
 *   https://play.pokemonshowdown.com/data/moves.json      954 moves, every field the engine
 *                                                        models (power, accuracy, pp,
 *                                                        priority, secondary, recoil, drain,
 *                                                        multihit, critRatio, boosts).
 *   https://play.pokemonshowdown.com/data/learnsets.json  3.05 MB, every learn method for
 *                                                        every generation.
 *
 * **The trim is the whole point.** learnsets.json is 3 MB and 95% of it is TM/egg/tutor/event
 * rows for generations we do not model. We keep LEVEL-UP entries from each species' latest
 * generation, for the species we ship, and then keep only the moves those entries reach — 3 MB
 * and 490 KB in, ~340 KB out. A browser game does not download a competitive teambuilder.
 *
 * Output is deterministic: every object key and every array is sorted before stringify, so
 * re-running on the same inputs produces byte-identical JSON.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SPECIES = join(REPO, 'public', 'generated', 'species.json');
const OUT_MOVES = join(REPO, 'public', 'generated', 'moves.json');
const OUT_LEARN = join(REPO, 'public', 'generated', 'learnsets.json');
const SD = 'https://play.pokemonshowdown.com/data';

/** Showdown's status ids, kept verbatim — `economy/items.js` already speaks four of them. */
const STATUSES = new Set(['brn', 'par', 'psn', 'tox', 'slp', 'frz']);

/** Same cache discipline as build-species.js: fetch once, then never touch the network. */
async function cached(url, name) {
  const file = join(REPO, 'node_modules', '.cache', name);
  if (existsSync(file)) { console.log(`${name}: cache hit`); return readFileSync(file, 'utf8'); }
  console.log(`${name}: fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return text;
}

const slugKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Which generation's level-up list to use, and the list itself.
 *
 * A learnset row is a tag list like `["9M","9L24","8L24","7L45","7V"]`: one letter of method
 * after the generation digit. `L` is level-up and it is the only one we want — `M` is a TM,
 * `E` an egg move, `T` a tutor, `S` an event, `V` Virtual Console.
 *
 * We take the LATEST generation that has any `L` row at all, rather than a fixed gen 9,
 * because a Pokemon cut from the current games (Furfrou, Vivillon forms) still has a perfectly
 * good gen 7 or gen 8 list and a hard `9L` filter would leave it with no moves whatsoever.
 */
function levelUpMoves(entry) {
  if (!entry?.learnset) return null;
  let best = 0;
  for (const tags of Object.values(entry.learnset)) {
    for (const tag of tags) {
      const m = /^(\d)L(\d+)$/.exec(tag);
      if (m && Number(m[1]) > best) best = Number(m[1]);
    }
  }
  if (!best) return null;
  const out = [];
  for (const [move, tags] of Object.entries(entry.learnset)) {
    for (const tag of tags) {
      const m = /^(\d)L(\d+)$/.exec(tag);
      // Level 0 is "known on evolution" and level 1 is the starting set; both read as 1 to a
      // game that only ever asks "what does this Pokemon know at level N".
      if (m && Number(m[1]) === best) out.push([Math.max(1, Number(m[2])), move]);
    }
  }
  // Sorted by level, then id: the emitted order IS the order `battle.movesFor` walks, so it
  // has to be total and stable or two builds disagree about which four moves a species has.
  out.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return out;
}

/**
 * Trims one Showdown move to the fields the engine models.
 *
 * Short keys because this ships to a browser and there are ~700 of them; the mapping is
 * documented here and mirrored in `src/battle/moves.js`, which is the only reader.
 *
 *   n  name        t  type (lowercase)   c  category: 0 status, 1 physical, 2 special
 *   p  base power  a  accuracy (0 = cannot miss)   pp   pr priority
 *   hc high-crit ratio     dr drain [n,d]      rc recoil [n,d]    mh multihit [min,max]
 *   st status inflicted    sv volatile status  bo stat boosts     sb boost target
 *   ss secondary { c: chance, st?, sv?, bo?, sb? }
 */
function trimMove(id, m) {
  const cat = m.category === 'Physical' ? 1 : m.category === 'Special' ? 2 : 0;
  const out = {
    n: m.name,
    t: String(m.type ?? 'Normal').toLowerCase(),
    c: cat,
    p: m.basePower ?? 0,
    // Showdown writes `true` for "cannot miss"; 0 is unambiguous and one byte.
    a: m.accuracy === true ? 0 : (m.accuracy ?? 100),
    pp: m.pp ?? 5,
    pr: m.priority ?? 0,
  };
  if (Number.isFinite(m.critRatio) && m.critRatio > 1) out.hc = m.critRatio;
  if (Array.isArray(m.drain)) out.dr = m.drain;
  if (Array.isArray(m.recoil)) out.rc = m.recoil;
  if (Array.isArray(m.multihit)) out.mh = m.multihit;
  else if (Number.isFinite(m.multihit)) out.mh = [m.multihit, m.multihit];

  if (typeof m.status === 'string' && STATUSES.has(m.status)) out.st = m.status;
  if (m.volatileStatus === 'confusion') out.sv = 'confusion';
  if (m.boosts && typeof m.boosts === 'object') {
    out.bo = m.boosts;
    out.sb = m.target === 'self' ? 'self' : 'foe';
  }

  const sec = m.secondary ?? (Array.isArray(m.secondaries) ? m.secondaries[0] : null);
  if (sec) {
    const s = { c: sec.chance ?? 100 };
    if (typeof sec.status === 'string' && STATUSES.has(sec.status)) s.st = sec.status;
    if (sec.volatileStatus === 'confusion') s.sv = 'confusion';
    if (sec.volatileStatus === 'flinch') s.sv = 'flinch';
    if (sec.boosts) { s.bo = sec.boosts; s.sb = 'foe'; }
    if (sec.self?.boosts) { s.bo = sec.self.boosts; s.sb = 'self'; }
    // A secondary with no modelled effect is not a secondary — dropping it keeps the engine
    // from rolling a coin whose outcome it would then ignore, which would move every
    // subsequent draw in the turn (unconditional draws keep RNG streams aligned).
    if (s.st || s.sv || s.bo) out.ss = s;
  }
  return out;
}

/** Sorted-key stringify, so the emitted bytes depend on the data and not on insertion order. */
const sortedObject = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));

async function main() {
  if (!existsSync(SPECIES)) throw new Error('run build-species.js first — species.json is the trim list');
  const species = JSON.parse(readFileSync(SPECIES, 'utf8'));
  const dexMoves = JSON.parse(await cached(`${SD}/moves.json`, 'showdown-moves.json'));
  const dexLearn = JSON.parse(await cached(`${SD}/learnsets.json`, 'showdown-learnsets.json'));

  const learnsets = {};
  const used = new Set();
  const noLearnset = [];
  let viaBase = 0;

  for (const s of species) {
    // A cosmetic form has its own sprite folder and no learnset of its own; fall back to the
    // base species rather than shipping a Pokemon that knows nothing (`build-species.js`
    // already folded its stats the same way).
    let rows = levelUpMoves(dexLearn[slugKey(s.name)]);
    if (!rows && s.base && s.base !== s.name) {
      rows = levelUpMoves(dexLearn[slugKey(s.base)]);
      if (rows) viaBase++;
    }
    if (!rows || !rows.length) { noLearnset.push(s.name); continue; }
    learnsets[s.name] = rows.map(([lvl, move]) => `${lvl}:${move}`);
    for (const [, move] of rows) used.add(move);
  }

  const moves = {};
  const missingMove = [];
  for (const id of [...used].sort()) {
    const m = dexMoves[id];
    if (!m) { missingMove.push(id); continue; }
    moves[id] = trimMove(id, m);
  }

  mkdirSync(dirname(OUT_MOVES), { recursive: true });
  writeFileSync(OUT_MOVES, JSON.stringify(sortedObject(moves)));
  writeFileSync(OUT_LEARN, JSON.stringify(sortedObject(learnsets)));

  const kb = (f) => (statSync(f).size / 1024).toFixed(0);
  const levels = Object.values(learnsets);
  const total = levels.reduce((a, l) => a + l.length, 0);

  console.log(`moves.json:     ${Object.keys(moves).length} moves, ${kb(OUT_MOVES)} KB`);
  console.log(`learnsets.json: ${levels.length} species, ${total} rows, ${kb(OUT_LEARN)} KB`);
  console.log(`  species matched via their base form: ${viaBase}`);
  console.log(`  average level-up moves per species: ${(total / levels.length).toFixed(1)}`);
  if (noLearnset.length) console.log(`  NO LEARNSET (${noLearnset.length}): ${noLearnset.slice(0, 12).join(', ')}${noLearnset.length > 12 ? ' …' : ''}`);
  if (missingMove.length) console.log(`  MOVE NOT IN DEX (${missingMove.length}): ${missingMove.join(', ')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
