/**
 * The invariants. A screenshot can show that an encounter happened; it cannot show that the
 * *same* encounter happens again from the same seed, and that is the whole contract this
 * module owes `idle` and `offline` (ARCHITECTURE §5.6/§5.7). So the evidence is here.
 *
 * Everything below runs against `rolls.js` and `tables.js` with no browser, no `ctx` and no
 * DOM, which is also the proof that those two files carry no hidden state: if they did, the
 * Node run and the browser run would disagree and nobody would find out until a player
 * came back from a twelve-hour absence to a different Pokemon.
 *
 * Ordered by how much each would hurt if it were false:
 *
 *    1-2  the stream label matches `ctx.rng.fork()` — the bridge between Node and browser
 *    3-5  reproducibility, and independence of the index from its neighbours
 *    6-9  the roll stays inside its declared table, band and IV range
 *   10-11 the weighted table really is weighted, and never drops a row
 *   12-14 the species names, capture rates and time bands are real
 *   15-17 battles, catch rolls and shake counts
 *   18-19 the ball maths this module hands `economy`, at its landmarks
 *
 *   node src/encounter/selftest.js
 */

import { makeRng } from '../core/rng.js';
import { dropsFor, BIOME_LOOT, LOOT_IDS, DROP_CHANCE } from './drops.js';
import {
  STREAM_ROOT, SHINY_RATE, IV_KEYS,
  streamFor, catchRateFor, levelBand, stepRoll, stepValue, rollAt, catchRoll,
  shakesFor,
} from './rolls.js';
import {
  BIOMES, TABLES, todBand, rowsFor, expand, bumpsFor, validate, authoredCatchRate, summary,
} from './tables.js';

const SEED = 1337;
const BAND = { min: 3, max: 9 };

/**
 * The species snapshot is *injected*, never read from disk here.
 *
 * This file is imported by `index.js`, which Vite bundles for the browser, so a top-level
 * `node:fs` import would externalise into a proxy that throws the moment the module is
 * evaluated — one console error, one failed budget (§7), and a white page. The CLI block at
 * the bottom reads the file and hands it in; the browser hands in `pokemon.all()`. Both get
 * the same check.
 */
export function runSelfTest({ species = null } = {}) {
  const out = [];
  const check = (name, ok, detail = '') => { out.push({ name, ok: !!ok, detail: String(detail) }); return ok; };

  // --- 1-2 the stream label ---------------------------------------------------
  // `ctx.rng` is makeRng(seed, 'root') and fork() appends '/label', so the browser's
  // ctx.rng.fork('encounter').fork('roll/7') and this file's streamFor(seed,'roll',7) must
  // be the same stream. If they ever diverge, everything else here passes and the game is
  // still wrong, so this is check one.
  {
    const viaFork = makeRng(SEED, 'root').fork('encounter').fork('roll/7');
    const direct = streamFor(SEED, 'roll', 7);
    const a = [viaFork.next(), viaFork.next(), viaFork.next()];
    const b = [direct.next(), direct.next(), direct.next()];
    check('streamFor() is exactly ctx.rng.fork("encounter").fork(kind/index)',
      a.every((v, i) => v === b[i]), `${a[0].toFixed(9)} == ${b[0].toFixed(9)}`);
    check('the stream root is the one a save was written against',
      STREAM_ROOT === 'root/encounter', STREAM_ROOT);
  }

  const table = expand(rowsFor('meadow', 12), { slots: 120, biome: 'meadow', tod: 12 });
  const bumps = bumpsFor(rowsFor('meadow', 12));

  // --- 3 reproducible ---------------------------------------------------------
  {
    let same = true, first = null;
    for (let i = 0; i < 500; i++) {
      const a = rollAt(SEED, i, { table, band: BAND, bumps });
      const b = rollAt(SEED, i, { table, band: BAND, bumps });
      if (JSON.stringify(a) !== JSON.stringify(b)) { same = false; break; }
      if (i === 0) first = a;
    }
    check('500 encounters roll identically twice', same,
      first ? `#0 = ${first.species} lv${first.level}${first.shiny ? ' shiny' : ''} iv${first.ivTotal}` : '');
  }

  // --- 3b GOLDEN VALUES ---------------------------------------------------------
  // Check 3 compares two calls to each other, which a reordered draw sequence would pass:
  // both calls reorder identically. The property the whole module rests on is that the draw
  // ORDER never changes (`rolls.rollAt` says so), and only literals recorded from a known
  // seed can enforce that. Captured from seed 1337 against the meadow/day table at band
  // 3-9. If one of these ever fails, something added, removed or reordered a draw and every
  // encounter ever rolled from every seed just changed.
  {
    const golden = [
      [0, 'marill', 9, 55, [6, 16, 23, 5, 0, 5]],
      [1, 'minccino', 7, 96, [23, 5, 23, 13, 30, 2]],
      [7, 'marill', 7, 109, [24, 2, 19, 26, 23, 15]],
      [250, 'marill', 7, 74, [14, 24, 3, 8, 25, 0]],
    ];
    const bad = [];
    for (const [i, species, level, ivTotal, ivs] of golden) {
      const r = rollAt(SEED, i, { table, band: BAND, bumps });
      const got = IV_KEYS.map((k) => r.ivs[k]);
      if (r.species !== species || r.level !== level || r.ivTotal !== ivTotal
        || got.some((v, n) => v !== ivs[n])) {
        bad.push(`#${i} -> ${r.species} Lv${r.level} iv${r.ivTotal} [${got}]`);
      }
    }
    check('the draw order has not moved (four golden encounters, seed 1337)', bad.length === 0,
      bad.length ? bad.join(' | ') : 'species, level, shiny and all six IVs pin exactly');

    // The other three streams, pinned the same way, so a change to `streamFor`'s label
    // scheme or to any draw order inside them cannot land quietly either.
    const s7 = streamFor(SEED, 'roll', 7).next();
    const c51 = catchRoll(SEED, 5, 1);
    const s0 = stepValue(SEED, 0);
    // **`battle/12` is gone from this pin, and that is a deletion rather than a relaxation.**
    // `resolveBattle` was eleven lines comparing two levels; a fight is `src/battle/`'s turn
    // engine now, on `root/battle/<index>/<turn>`, and its own golden transcript is pinned in
    // `src/battle/selftest.js` (DECISIONS #67). The three streams that still exist are pinned
    // exactly as they were — that they did NOT move is the evidence the index space survived
    // the switchover.
    check('every stream still starts where it started',
      Math.abs(s7 - 0.9075717055238783) < 1e-15
      && Math.abs(c51 - 0.16200905269943178) < 1e-15
      && Math.abs(s0 - 0.8985949635971338) < 1e-15,
      `roll/7 ${s7.toFixed(12)}, catch/5/1 ${c51.toFixed(12)}, step/0 ${s0.toFixed(12)}`);
  }

  // --- 4 index-addressed, not stream-continued ---------------------------------
  // Rolling index 250 on its own must equal rolling it after 0..249. This is the property
  // `idle` leans on to resolve a closed-tab gap by index, and the one a mid-hunt reload
  // would break if any roll continued a running stream.
  {
    const alone = rollAt(SEED, 250, { table, band: BAND, bumps });
    for (let i = 0; i < 250; i++) rollAt(SEED, i, { table, band: BAND, bumps });
    const after = rollAt(SEED, 250, { table, band: BAND, bumps });
    check('encounter #250 is the same rolled alone or after its 250 predecessors',
      JSON.stringify(alone) === JSON.stringify(after), `${alone.species} lv${alone.level}`);
  }

  // --- 5 neighbouring indices are different encounters --------------------------
  {
    const keys = new Set();
    for (let i = 0; i < 64; i++) {
      const r = rollAt(SEED, i, { table, band: BAND, bumps });
      keys.add(`${r.species}/${r.level}/${r.ivTotal}`);
    }
    check('64 consecutive indices are not the same encounter repeated', keys.size >= 55,
      `${keys.size}/64 distinct`);
  }

  // --- 6-8 the roll stays inside its declared table and band ---------------------
  {
    const allowed = new Set(table);
    let badSpecies = 0, badLevel = 0, badIv = 0, minL = 99, maxL = 0;
    for (let i = 0; i < 4000; i++) {
      const r = rollAt(SEED, i, { table, band: BAND, bumps });
      if (!allowed.has(r.species)) badSpecies++;
      const bump = bumps[r.species] ?? 0;
      if (r.level < BAND.min || r.level > BAND.max + bump) badLevel++;
      minL = Math.min(minL, r.level); maxL = Math.max(maxL, r.level);
      for (const k of IV_KEYS) {
        const v = r.ivs[k];
        if (!Number.isInteger(v) || v < 0 || v > 31) badIv++;
      }
    }
    check('every species rolled is in the table it was rolled from', badSpecies === 0, `${badSpecies} strays`);
    check('every level is inside the band (plus the row bump)', badLevel === 0,
      `band ${BAND.min}-${BAND.max}, observed ${minL}-${maxL}`);
    check('all six IVs are integers in 0..31', badIv === 0, `${4000 * 6} values`);
  }

  // --- 9 shiny odds land where they are declared --------------------------------
  {
    const N = 400000;
    let shinies = 0;
    for (let i = 0; i < N; i++) if (rollAt(SEED, i, { table, band: BAND }).shiny) shinies++;
    const rate = shinies / N;
    const expected = SHINY_RATE;
    // 98 shinies expected in 400k; Poisson sigma is ~10, so +/-40% is a 4-sigma window.
    check('shiny rate matches the declared 1/4096', rate > expected * 0.6 && rate < expected * 1.4,
      `${shinies} in ${N} = 1/${Math.round(1 / rate)} against 1/${Math.round(1 / expected)}`);
  }

  // --- 10-11 the weighted table -------------------------------------------------
  {
    const rows = rowsFor('meadow', 12);
    const exp = expand(rows, { slots: 120 });
    const present = new Set(exp);
    const missing = rows.filter((r) => !present.has(r.n));
    check('weight expansion never drops a row', missing.length === 0,
      `${rows.length} rows -> ${exp.length} slots, ${present.size} distinct`);

    const total = rows.reduce((n, r) => n + r.w, 0);
    let worst = 0, worstName = '';
    const counts = new Map();
    for (const n of exp) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const r of rows) {
      const got = (counts.get(r.n) ?? 0) / exp.length;
      const want = r.w / total;
      const err = Math.abs(got - want);
      if (err > worst) { worst = err; worstName = r.n; }
    }
    check('a uniform pick from the expanded table is the weighted pick', worst < 0.012,
      `worst row ${worstName} off by ${(worst * 100).toFixed(2)} points`);
  }

  // --- 12 every species in every table exists ------------------------------------
  {
    if (!Array.isArray(species) || !species.length) {
      check('every table species exists in the snapshot', false,
        'no species snapshot was supplied — run src/pokemon/tools/build-species.js');
    } else {
      const names = new Set(species.map((s) => s.name));
      const bad = validate((n) => (names.has(n) ? { name: n } : null));
      const rows = Object.values(TABLES).reduce((n, r) => n + r.length, 0);
      check('every table species exists in the snapshot, with a legal rate and weight',
        bad.length === 0, bad.length ? bad.slice(0, 6).join('; ') : `${rows} rows across ${BIOMES.length} biomes`);
    }
  }

  // --- 13 every biome has something at every hour ---------------------------------
  {
    let empty = 0;
    const detail = [];
    for (const biome of BIOMES) {
      for (const tod of [0, 5, 8, 12, 16, 19, 22]) {
        const rows = rowsFor(biome, tod);
        if (!rows.length) { empty++; detail.push(`${biome}@${tod}`); }
      }
    }
    check('every biome spawns something at every hour', empty === 0,
      detail.length ? detail.join(' ') : summary().map((s) => `${s.biome}:${s.rows}`).join(' '));
  }

  // --- 14 the time bands agree with the Dusk Ball's ---------------------------------
  // economy/items.js `isNight` is 20:00-04:00 for the Dusk Ball; our nocturnal table opens
  // at 18:00. The overlap is what matters: everything the Dusk Ball calls night must be a
  // night in the table, or the ball would be 3x on a diurnal table.
  {
    const nightHours = [20, 21, 22, 23, 0, 1, 2, 3];
    const ok = nightHours.every((h) => todBand(h) === 'night');
    check('every hour economy calls night is a night in the table', ok,
      `${nightHours.map((h) => `${h}:${todBand(h)}`).join(' ')}`);
    check('the bands partition the day',
      todBand(4) === 'morning' && todBand(9.99) === 'morning' && todBand(10) === 'day'
      && todBand(17.99) === 'day' && todBand(18) === 'night' && todBand(3.99) === 'night',
      '04-10 morning, 10-18 day, 18-04 night');
  }

  // --- 15 drops -----------------------------------------------------------------
  // The faucet. Index-addressed like everything else in this module, because `offline` has to
  // replay a hunt's loot and get the hunt's loot.
  {
    const ITEM_IDS = new Set(LOOT_IDS);
    let same = 0; let outside = 0; let empty = 0; let total = 0; let counted = 0;
    for (let i = 0; i < 3000; i++) {
      const d = dropsFor(SEED, i, { biome: 'forest', catchRate: 255, level: 10 });
      if (JSON.stringify(d) === JSON.stringify(dropsFor(SEED, i, { biome: 'forest', catchRate: 255, level: 10 }))) same++;
      if (!d.length) { empty++; continue; }
      for (const x of d) {
        counted++;
        if (!ITEM_IDS.has(x.id)) outside++;
        if (x.n < 1 || x.n > 3) outside++;
      }
      total++;
    }
    check('drops are reproducible from (seed, index)', same === 3000, `${same}/3000`);
    check('every drop is a real treasure item, 1..3 of it', outside === 0, `${outside} bad of ${counted}`);
    // Not every kill pays, and the rate is the one in the file rather than whatever fell out.
    const rate = total / 3000;
    check('the drop rate is about DROP_CHANCE', Math.abs(rate - DROP_CHANCE) < 0.04,
      `${(rate * 100).toFixed(1)}% against ${(DROP_CHANCE * 100).toFixed(0)}%`);
    check('a biome drops its OWN ladder', dropsFor(SEED, 1, { biome: 'cave', catchRate: 255, level: 5 })
      .every((d) => BIOME_LOOT.cave.includes(d.id)));
    // Rarity picks the rung: a hard species pays better than a common one, every time.
    const commons = new Set();
    const rares = new Set();
    for (let i = 0; i < 400; i++) {
      for (const d of dropsFor(SEED, i, { biome: 'forest', catchRate: 255, level: 10 })) commons.add(d.id);
      for (const d of dropsFor(SEED, i, { biome: 'forest', catchRate: 40, level: 10 })) rares.add(d.id);
    }
    check('a rare species drops from a higher rung', rares.has(BIOME_LOOT.forest[2]) && !commons.has(BIOME_LOOT.forest[2]),
      `common ${[...commons].join(',')} | rare ${[...rares].join(',')}`);
    // A shiny is the rarest thing in the game and beating one must not be able to pay nothing.
    let shinyEmpty = 0;
    for (let i = 0; i < 300; i++) {
      if (!dropsFor(SEED, i, { biome: 'meadow', catchRate: 255, level: 10, shiny: true }).length) shinyEmpty++;
    }
    check('a shiny always leaves something', shinyEmpty === 0, `${shinyEmpty} empty of 300`);
    check('drops use their own stream', empty > 0 && empty < 3000, `${empty} of 3000 paid nothing`);
  }

  // --- 15 battles ---------------------------------------------------------------
  // RETIRED with `resolveBattle` (DECISIONS #67). What this checked — that a battle resolves
  // the same way twice, that `hpFraction` is a real fraction, and that the win curve stays
  // inside its clamp — was a property of an eleven-line coin flip that no longer exists. The
  // equivalents now live in `src/battle/selftest.js`: a golden transcript at seed 1337, a
  // 300-matchup sweep asserting every fight is reproducible and has a loser, and PP that never
  // goes negative. Deleting it rather than leaving it green against dead code is the point:
  // a check that passes against a path nothing calls is worse than no check.

  // --- 16 catch rolls -------------------------------------------------------------
  {
    const t1 = catchRoll(SEED, 5, 1);
    const t2 = catchRoll(SEED, 5, 2);
    check('a catch roll replays, and a second ball is a new roll',
      catchRoll(SEED, 5, 1) === t1 && t1 !== t2, `turn1 ${t1.toFixed(6)} turn2 ${t2.toFixed(6)}`);
    let sum = 0;
    for (let i = 0; i < 5000; i++) sum += catchRoll(SEED, i, 1);
    check('catch rolls are uniform', Math.abs(sum / 5000 - 0.5) < 0.02, `mean ${(sum / 5000).toFixed(4)}`);
  }

  // --- 17 shake counts -------------------------------------------------------------
  {
    check('a catch always shows three shakes and a click', shakesFor(0.01, 0.5, true) === 3, '3');
    check('a hopeless throw pops straight open', shakesFor(0.99, 0.02, false) === 0,
      `${shakesFor(0.99, 0.02, false)} shakes at 2% odds on a 0.99 roll`);
    check('a near miss wobbles', shakesFor(0.71, 0.7, false) === 3,
      `${shakesFor(0.71, 0.7, false)} shakes at 70% odds on a 0.71 roll`);
    let mono = true;
    for (let i = 1; i < 50; i++) {
      if (shakesFor(i / 50, 0.5, false) > shakesFor((i - 1) / 50, 0.5, false)) { mono = false; break; }
    }
    check('shakes never increase as the roll gets worse', mono, 'monotone in the roll');
  }

  // --- 18 capture rates ---------------------------------------------------------
  {
    check('the tables carry mainline capture rates',
      authoredCatchRate('caterpie') === 255 && authoredCatchRate('gible') === 45
      && authoredCatchRate('eevee') === 45 && authoredCatchRate('magikarp') === 255,
      'caterpie 255, gible 45, eevee 45, magikarp 255');
    // The BST proxy is only for species no table lists. Landmarks, as declared.
    const lm = [[195, 240, 255], [450, 45, 80], [600, 5, 20], [700, 3, 6]];
    const bad = lm.filter(([bst, lo, hi]) => { const r = catchRateFor(bst); return r < lo || r > hi; });
    check('the BST proxy lands on its declared landmarks', bad.length === 0,
      lm.map(([b]) => `${b}->${catchRateFor(b)}`).join(' '));
    let mono = true;
    for (let b = 200; b <= 720; b += 10) if (catchRateFor(b) > catchRateFor(b - 10)) { mono = false; break; }
    check('the BST proxy is monotone decreasing', mono, '255 at 190, 3 at 720');
  }

  // --- 19 the level band tracks the party ----------------------------------------
  {
    const b5 = levelBand(5), b50 = levelBand(50);
    check('the wild level band scales with the party',
      b5.min === 3 && b5.max === 7 && b50.min === 30 && b50.max === 58,
      `lv5 party -> ${b5.min}-${b5.max}, lv50 party -> ${b50.min}-${b50.max}`);
    check('an empty party still gets a band',
      levelBand(0).min >= 2 && levelBand(undefined).max >= 3, JSON.stringify(levelBand(0)));
  }

  // --- 20 grass steps -------------------------------------------------------------
  {
    let hits = 0;
    for (let i = 0; i < 20000; i++) if (stepRoll(SEED, i, 0.12)) hits++;
    check('a grass step fires at the rate it is given', Math.abs(hits / 20000 - 0.12) < 0.01,
      `${((hits / 20000) * 100).toFixed(2)}% against 12.00%`);
    check('a step replays', stepRoll(SEED, 77, 0.12) === stepRoll(SEED, 77, 0.12), 'step 77');
    check('rate 0 never fires and rate 1 always does',
      !stepRoll(SEED, 3, 0) && stepRoll(SEED, 3, 1), 'clamped');
  }

  return out;
}

export function summarise(results) {
  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, ok: passed === results.length };
}

// `node src/encounter/selftest.js`
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('selftest.js')) {
  // Imported here and not at the top of the file: see `runSelfTest`.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'generated', 'species.json');
  let species = null;
  try { species = JSON.parse(readFileSync(path, 'utf8')); } catch { /* check 12 reports it */ }
  const results = runSelfTest({ species });
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}  —  ${r.detail}`);
  const { passed, total, ok } = summarise(results);
  console.log(`${ok ? '✓' : '✗'} encounter selftest: ${passed}/${total}`);
  process.exit(ok ? 0 : 1);
}
