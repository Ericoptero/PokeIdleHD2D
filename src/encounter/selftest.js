/**
 * The invariants. A screenshot can show that an encounter happened; it cannot show that the
 * *same* encounter happens again from the same seed, and that is the whole contract this
 * module owes `idle` and `offline` (src/encounter/index.js and src/idle/index.js). So the evidence is here.
 *
 * Everything below runs against `rolls.js` and `tables.js` with no browser, no `ctx` and no
 * DOM, which is also the proof that those two files carry no hidden state: if they did, the
 * Node run and the browser run would disagree and nobody would find out until a player
 * came back from a twelve-hour absence to a different Pokemon.
 *
 * There is no more shared table catalog to pin species names against (`./tables.js`'s own
 * header) — every map authors its own `spawnPoints[]`, so the checks that used to validate
 * `TABLES`'s content moved: `rowsFromSpawnPoints`'s own merge/`when`-filter contract is
 * checked here against a literal fixture instead, and the mechanics checks (draw order, band,
 * IV range, shiny odds) run against that same small fixture rather than a real biome.
 *
 * Ordered by how much each would hurt if it were false:
 *
 *    1-2  the stream label matches `ctx.rng.fork()` — the bridge between Node and browser
 *    3-5  reproducibility, and independence of the index from its neighbours
 *    6-9  the roll stays inside its declared table, band and IV range
 *   10-11 the weighted table really is weighted, and never drops a row; the `when` filter works
 *   12-13 the time bands agree with the Dusk Ball's, and drops are index-addressed and real
 *   14-16 battles, catch rolls and shake counts
 *   17    capture rate comes off the species record, with a monotone BST fallback
 *
 *   node src/encounter/selftest.js
 */

import { makeRng } from '../core/rng.js';
import { dropsFor, tableFor, MAX_DROP_ROWS } from './drops.js';
import { THROWS_PER_FAINT, WIPE_PENALTY } from './index.js';
import { PROFILE, profileFor, shapeOf, BEATS, beatAt, MOTION, ROLE } from './vfx/elements.js';
import { PARTICLE_COUNT } from './vfx/particles.js';
import { planBeats } from './beats.js';
import {
  STREAM_ROOT, SHINY_RATE, IV_KEYS,
  streamFor, catchRateFor, levelBand, rollAt, catchRoll,
  shakesFor,
} from './rolls.js';
import { todBand, rowsFromSpawnPoints, expand, bumpsFor } from './tables.js';

const SEED = 1337;
const BAND = { min: 3, max: 9 };

/** A small literal fixture, unrelated to any real map — the mechanics checks below only need
 *  *some* fixed weighted rows, not a real spawn point's own species list. */
const FIXTURE_SPAWN_POINTS = [
  {
    species: [
      { name: 'patrat', chance: 18, when: 'day' }, { name: 'lillipup', chance: 16, when: 'day' },
      { name: 'hoothoot', chance: 18, when: 'night' }, { name: 'purrloin', chance: 14, when: 'night' },
      { name: 'pidgey', chance: 12, when: 'any' }, { name: 'oddish', chance: 10, when: 'any' },
      { name: 'eevee', chance: 2, when: 'any', bump: 2 },
    ],
  },
  {
    species: [
      { name: 'rattata', chance: 12, when: 'any' }, { name: 'marill', chance: 6, when: 'any' },
    ],
  },
];

/**
 * The species snapshot (and, for the drops checks, the committed drop catalog) are
 * *injected*, never read from disk here.
 *
 * This file is imported by `index.js`, which Vite bundles for the browser, so a top-level
 * `node:fs` import would externalise into a proxy that throws the moment the module is
 * evaluated — one console error, one failed budget (tools/shots/shoot.js), and a white page.
 * The CLI block at the bottom reads both files and hands them in; the browser hands in
 * `pokemon.all()` and the catalog it already fetched at init. Both get the same check.
 */
export function runSelfTest({ species = null, catalog = null } = {}) {
  const out = [];
  const check = (name, ok, detail = '') => { out.push({ name, ok: !!ok, detail: String(detail) }); return ok; };
  const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

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

  const fixtureRows = rowsFromSpawnPoints(FIXTURE_SPAWN_POINTS, 12);
  const table = expand(fixtureRows, { slots: 120, mapId: 'fixture', tod: 12 });
  const bumps = bumpsFor(fixtureRows);

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

  // --- 3b every stream still starts where it started ------------------------------
  // A literal check on the streams themselves, independent of any table content: if
  // `streamFor`'s label scheme or draw order inside it ever moves, every roll from every
  // seed changes and this catches it before a golden encounter pin would.
  {
    const s7 = streamFor(SEED, 'roll', 7).next();
    const c51 = catchRoll(SEED, 5, 1);
    check('every stream still starts where it started',
      Math.abs(s7 - 0.9075717055238783) < 1e-15
      && Math.abs(c51 - 0.16200905269943178) < 1e-15,
      `roll/7 ${s7.toFixed(12)}, catch/5/1 ${c51.toFixed(12)}`);
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
    check('64 consecutive indices are not the same encounter repeated', keys.size >= 50,
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

  // --- 10 the weighted table ------------------------------------------------------
  {
    const exp = expand(fixtureRows, { slots: 120 });
    const present = new Set(exp);
    const missing = fixtureRows.filter((r) => !present.has(r.n));
    check('weight expansion never drops a row', missing.length === 0,
      `${fixtureRows.length} rows -> ${exp.length} slots, ${present.size} distinct`);

    const total = fixtureRows.reduce((n, r) => n + r.w, 0);
    let worst = 0, worstName = '';
    const counts = new Map();
    for (const n of exp) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const r of fixtureRows) {
      const got = (counts.get(r.n) ?? 0) / exp.length;
      const want = r.w / total;
      const err = Math.abs(got - want);
      if (err > worst) { worst = err; worstName = r.n; }
    }
    check('a uniform pick from the expanded table is the weighted pick', worst < 0.02,
      `worst row ${worstName} off by ${(worst * 100).toFixed(2)} points`);
  }

  // --- 11 rowsFromSpawnPoints: merge across points, filter by hour ---------------
  {
    const day = rowsFromSpawnPoints(FIXTURE_SPAWN_POINTS, 12);
    const night = rowsFromSpawnPoints(FIXTURE_SPAWN_POINTS, 22);
    check('a day roll never includes a night-only row',
      !day.some((r) => r.n === 'hoothoot' || r.n === 'purrloin'), day.map((r) => r.n).join(','));
    check('a night roll never includes a day-only row',
      !night.some((r) => r.n === 'patrat' || r.n === 'lillipup'), night.map((r) => r.n).join(','));
    check('an "any" row is in both', day.some((r) => r.n === 'pidgey') && night.some((r) => r.n === 'pidgey'));
    // `marill` appears on only one spawn point, at weight 6 — its merged weight should be
    // exactly that, not summed with anything else.
    const marill = day.find((r) => r.n === 'marill');
    eq('a species on one spawn point keeps that point\'s own weight', marill?.w, 6);
    // A species named on two spawn points would sum; none of this fixture's rows are, so the
    // merge is also implicitly proven not to over-count a species that appears once.
    check('bump carries through from the species row', bumpsFor(day).eevee === 2, JSON.stringify(bumpsFor(day)));
  }

  // --- 12 the time bands agree with the Dusk Ball's ---------------------------------
  // economy/items.js `isNight` is 20:00-04:00 for the Dusk Ball; our nocturnal band opens
  // at 18:00. The overlap is what matters: everything the Dusk Ball calls night must be a
  // night here, or the ball would be 3x on a diurnal spawn.
  {
    const nightHours = [20, 21, 22, 23, 0, 1, 2, 3];
    const ok = nightHours.every((h) => todBand(h) === 'night');
    check('every hour economy calls night is a night in the band', ok,
      `${nightHours.map((h) => `${h}:${todBand(h)}`).join(' ')}`);
    check('the bands partition the day',
      todBand(4) === 'morning' && todBand(9.99) === 'morning' && todBand(10) === 'day'
      && todBand(17.99) === 'day' && todBand(18) === 'night' && todBand(3.99) === 'night',
      '04-10 morning, 10-18 day, 18-04 night');
  }

  // --- 13 drops -----------------------------------------------------------------
  // The faucet. Index-addressed like everything else in this module, because `offline` has to
  // replay a hunt's loot and get the hunt's loot. Each species defines its own table now
  // (`./drops.js`'s own header) — the catalog is the committed `drops.json`, injected here
  // exactly like the species snapshot is.
  {
    if (!catalog || !Object.keys(catalog).length) {
      check('drops are reproducible from (seed, index)', false,
        'no drops catalog was supplied — run src/pokemon/tools/build-drops.js');
    } else {
      const itemIds = new Set(Object.values(catalog).flat().map((r) => r.id));
      let same = 0; let outside = 0; let empty = 0; let counted = 0;
      for (let i = 0; i < 3000; i++) {
        const opts = { species: 'caterpie', catalog, level: 10 };
        const d = dropsFor(SEED, i, opts);
        if (JSON.stringify(d) === JSON.stringify(dropsFor(SEED, i, opts))) same++;
        if (!d.length) { empty++; continue; }
        for (const x of d) {
          counted++;
          if (!itemIds.has(x.id)) outside++;
          if (x.n < 1 || x.n > 3) outside++;
        }
      }
      check('drops are reproducible from (seed, index)', same === 3000, `${same}/3000`);
      check('every drop is a real treasure item, 1..3 of it', outside === 0, `${outside} bad of ${counted}`);
      check('drops use their own stream', empty > 0 && empty < 3000, `${empty} of 3000 paid nothing`);

      // A shiny is the rarest thing in the game and beating one must not be able to pay nothing.
      let shinyEmpty = 0;
      for (let i = 0; i < 300; i++) {
        if (!dropsFor(SEED, i, { species: 'caterpie', catalog, level: 10, shiny: true }).length) shinyEmpty++;
      }
      check('a shiny always leaves something', shinyEmpty === 0, `${shinyEmpty} empty of 300`);

      // The budget, which is the determinism claim: a table may never cost more draws than the
      // stream reserves for it, whatever species a slot happens to be holding.
      const widest = Math.max(0, ...Object.values(catalog).map((t) => t.length));
      check('no table exceeds the draw budget', widest <= MAX_DROP_ROWS, `widest ${widest} of ${MAX_DROP_ROWS}`);

      // Two different species at the SAME index take the same number of draws, so a respawn
      // cannot renumber the loot of every encounter after it.
      if (catalog.caterpie && catalog.dragonite) {
        const a = dropsFor(SEED, 5, { species: 'caterpie', catalog, level: 5 });
        const b = dropsFor(SEED, 5, { species: 'dragonite', catalog, level: 5 });
        check('a different species at one index gives different loot',
          JSON.stringify(a) !== JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        const after = dropsFor(SEED, 6, { species: 'caterpie', catalog, level: 5 });
        eq('…and index 6 is untouched by which species index 5 held',
          JSON.stringify(after), JSON.stringify(dropsFor(SEED, 6, { species: 'caterpie', catalog, level: 5 })));
      }

      // `tableFor` on its own, for a readout that wants the rows and not a roll.
      if (catalog.caterpie) {
        const t = tableFor('caterpie', catalog);
        check('a table has the shape the brief asks for',
          t.every((r) => typeof r.id === 'string' && r.min >= 1 && r.max >= r.min
            && r.chance > 0 && r.chance <= 1), JSON.stringify(t[0]));
      }
    }
  }

  // --- 14 catch rolls -------------------------------------------------------------
  {
    const t1 = catchRoll(SEED, 5, 1);
    const t2 = catchRoll(SEED, 5, 2);
    check('a catch roll replays, and a second ball is a new roll',
      catchRoll(SEED, 5, 1) === t1 && t1 !== t2, `turn1 ${t1.toFixed(6)} turn2 ${t2.toFixed(6)}`);
    let sum = 0;
    for (let i = 0; i < 5000; i++) sum += catchRoll(SEED, i, 1);
    check('catch rolls are uniform', Math.abs(sum / 5000 - 0.5) < 0.02, `mean ${(sum / 5000).toFixed(4)}`);
  }

  // --- 15 shake counts -------------------------------------------------------------
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

  // --- 16 the level band tracks the party ----------------------------------------
  {
    const b5 = levelBand(5), b50 = levelBand(50);
    check('the wild level band scales with the party',
      b5.min === 3 && b5.max === 7 && b50.min === 30 && b50.max === 58,
      `lv5 party -> ${b5.min}-${b5.max}, lv50 party -> ${b50.min}-${b50.max}`);
    check('an empty party still gets a band',
      levelBand(0).min >= 2 && levelBand(undefined).max >= 3, JSON.stringify(levelBand(0)));
  }

  // --- 17 capture rate comes off the species record -------------------------------
  {
    if (!Array.isArray(species) || !species.length) {
      check('capture rate comes off the species record', false,
        'no species snapshot was supplied — run src/pokemon/tools/build-species.js');
    } else {
      const by = Object.fromEntries(species.map((s) => [s.name, s]));
      check('the snapshot carries mainline capture rates',
        by.caterpie?.catchRate === 255 && by.gible?.catchRate === 45
        && by.eevee?.catchRate === 45 && by.magikarp?.catchRate === 255,
        `caterpie ${by.caterpie?.catchRate}, gible ${by.gible?.catchRate}, `
        + `eevee ${by.eevee?.catchRate}, magikarp ${by.magikarp?.catchRate}`);
    }
    // The BST proxy is only for something with no species record at all. Landmarks, as declared.
    const lm = [[195, 240, 255], [450, 45, 80], [600, 5, 20], [700, 3, 6]];
    const bad = lm.filter(([bst, lo, hi]) => { const r = catchRateFor(bst); return r < lo || r > hi; });
    check('the BST proxy lands on its declared landmarks', bad.length === 0,
      lm.map(([b]) => `${b}->${catchRateFor(b)}`).join(' '));
    let mono = true;
    for (let b = 200; b <= 720; b += 10) if (catchRateFor(b) > catchRateFor(b - 10)) { mono = false; break; }
    check('the BST proxy is monotone decreasing', mono, '255 at 190, 3 at 720');
  }

  // --- 18 every move has a look, and it is derived -------------------------------
  //
  // 721 moves, twenty-one authored pieces: eighteen elemental palettes (`battle.typeColour`,
  // per-type colours) crossed with three delivery shapes, each shape a four-beat timeline
  // (`vfx/elements.js`). What is worth pinning here — the colour half moved to
  // `battle/selftest.js` #61-66 when `battle/types.js` became the one canonical table — is
  // that the shape/beat/profile crossing is total: a move added to `moves.json` tomorrow, or a
  // type this table has never seen, must not fall through to nothing.
  {
    eq('a status move is a field glyph', shapeOf({ c: 0 }), 'field');
    eq('a physical move is contact', shapeOf({ c: 1 }), 'contact');
    eq('a special move travels', shapeOf({ c: 2 }), 'projectile');
    // Never nothing: an unknown move still gets a look, because a move with no effect at all
    // reads as a bug rather than as a design decision.
    eq('an unknown move still has a shape', shapeOf(null), 'contact');

    eq('there are eighteen movement personalities', Object.keys(PROFILE).length, 18);
    const motions = new Set(Object.values(MOTION));
    const roles = new Set(Object.values(ROLE));
    check('every profile is one of the five motions and six roles',
      Object.values(PROFILE).every((p) => motions.has(p.motion) && roles.has(p.role) && p.intensity > 0));
    eq('and an unknown type still resolves to a profile', profileFor('nonsense'), PROFILE.normal);
    check('every one of the eighteen types resolves to its own profile',
      Object.keys(PROFILE).every((t) => profileFor(t) === PROFILE[t]));

    // The four-beat timeline: charge, deliver, impact, resolve, covering [0,1] with no gap and
    // no overlap for every shape — a strike whose phase fell in a hole between two beats would
    // freeze mid-effect on a showcase and nobody would notice until that exact phase was asked
    // for (a screenshot caught mid-settle can hide a broken animation).
    for (const shape of ['contact', 'projectile', 'field']) {
      const beats = BEATS[shape];
      check(`${shape}'s beats start at 0`, beats[0].from === 0);
      check(`${shape}'s beats end at 1`, beats[beats.length - 1].to === 1);
      check(`${shape}'s beats have no gap or overlap`,
        beats.every((b, i) => i === 0 || b.from === beats[i - 1].to));
      check(`${shape}'s beats are named charge, deliver, impact, resolve in order`,
        beats.map((b) => b.name).join(',') === 'charge,deliver,impact,resolve');
    }
    check('beatAt names the right beat at each boundary and holds the last beat at phase 1',
      beatAt('contact', 0).name === 'charge'
      && beatAt('contact', 0.15).name === 'deliver'
      && beatAt('contact', 0.9999).name === 'resolve'
      && beatAt('contact', 1).name === 'resolve'
      && beatAt('contact', 1).k === 1);
    check('an unrecognised shape falls back to contact\'s own timeline',
      JSON.stringify(BEATS[shapeOf(undefined)]) === JSON.stringify(BEATS.contact));

    // The particle field is one fixed-size buffer built once at init (`vfx/particles.js`) —
    // pinning its own declared cap here is what stops a future retune from quietly asking a
    // 128-quad buffer for more particles than it has room to draw.
    check('the shared particle field has a sane, fixed size',
      Number.isInteger(PARTICLE_COUNT) && PARTICLE_COUNT > 0 && PARTICLE_COUNT <= 512);
  }

  // --- 19 the two rules a fight is settled by -------------------------------------
  //
  // Both are constants rather than settings, and both are the kind of thing a later change
  // would quietly relax: a second ball "so a rare one is not lost", a five per cent wipe
  // "because ten feels harsh". Pinning them is what makes relaxing one a decision somebody
  // has to take on purpose.
  {
    check('one ball per defeated wild, and it is not configurable',
      THROWS_PER_FAINT === 1, `${THROWS_PER_FAINT}`);
    check('a wipe costs a tenth of the wallet', WIPE_PENALTY === 0.10, `${WIPE_PENALTY}`);
    // The ladder `economy/pricing.js` is anchored to only means something while a throw costs
    // a victory: at 7 balls to a guaranteed common, two throws per faint would halve every
    // grind in the game at a stroke.
    check('the pity ladder still measures victories, not a full bag',
      THROWS_PER_FAINT * 7 >= 7, 'a common is seven won fights');
  }

  // --- 20 planBeats: the timeline never lets two actions land in the same tick ---
  {
    const BEATS_CFG = { actionSteps: 18, itemSteps: 16, reviveSteps: 100 };
    const strike = (patch) => ({ turn: 1, attacker: 'a', move: 'tackle', cause: null, use: null, ...patch });

    const three = planBeats([strike({ attacker: 'a' }), strike({ attacker: 'b' }), strike({ attacker: 'a' })], BEATS_CFG);
    check('one beat per strike', three.length === 3, `${three.length}`);
    check('the order the engine produced is kept, not reordered',
      three.map((b) => b.strike.attacker).join('') === 'aba', three.map((b) => b.strike.attacker).join(''));
    check('every beat starts strictly after the one before it — never two in the same tick',
      three.every((b, i) => i === 0 || b.at > three[i - 1].at), three.map((b) => b.at).join(','));
    check('an ordinary strike is one ACTION_STEPS apart from the next',
      three[1].at - three[0].at === BEATS_CFG.actionSteps, `${three[1].at - three[0].at}`);

    const withItem = planBeats([strike({}), strike({ cause: 'item', use: 'potion', move: null }), strike({})], BEATS_CFG);
    check('an item strike holds itemSteps, not actionSteps',
      withItem[2].at - withItem[1].at === BEATS_CFG.itemSteps, `${withItem[2].at - withItem[1].at}`);

    const withRevive = planBeats([strike({ cause: 'item', use: 'revive', move: null }), strike({})], BEATS_CFG);
    check('a revive holds reviveSteps, which can be longer than any other beat',
      withRevive[1].at - withRevive[0].at === BEATS_CFG.reviveSteps, `${withRevive[1].at - withRevive[0].at}`);

    check('an empty turn plans to nothing', planBeats([], BEATS_CFG).length === 0, '0');
    check('planBeats does not mutate its input',
      (() => { const s2 = [strike({})]; const copy = JSON.stringify(s2); planBeats(s2, BEATS_CFG); return JSON.stringify(s2) === copy; })(),
      'unchanged');
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
  const genDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'generated');
  let species = null;
  try { species = JSON.parse(readFileSync(join(genDir, 'species.json'), 'utf8')); } catch { /* check 17 reports it */ }
  let catalog = null;
  try { catalog = JSON.parse(readFileSync(join(genDir, 'drops.json'), 'utf8')); } catch { /* check 13 reports it */ }
  const results = runSelfTest({ species, catalog });
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}  —  ${r.detail}`);
  const { passed, total, ok } = summarise(results);
  console.log(`${ok ? '✓' : '✗'} encounter selftest: ${passed}/${total}`);
  process.exit(ok ? 0 : 1);
}
