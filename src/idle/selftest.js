/**
 * selftest.js — the properties the idle core promises, expressed as checks that run in
 * both worlds: `node src/idle/selftest.js` during development, and inside the showcase so
 * a critic can read the results off the screen instead of taking my word for them.
 *
 * These are not decoration. Chunk additivity is the assumption `drain.js` makes when it
 * slices a three-hour gap, and the assumption `offline` makes when it applies the same gap
 * in one call. If it breaks, the two disagree and the player is the one who finds out.
 */

import { simulate, production, digest, BIOMES, UNLOCKS } from './accrual.js';
import { makeDrain } from './drain.js';

/** A fixed party, so a check never depends on what the pokemon module happens to hold. */
export const FIXTURE_PARTY = [
  { instanceId: 'a', level: 24, shiny: false, species: { name: 'sprigatito', types: ['grass'], baseStats: { hp: 40, atk: 61, def: 54, spa: 45, spd: 45, spe: 65 } } },
  { instanceId: 'b', level: 19, shiny: true, species: { name: 'eevee', types: ['normal'], baseStats: { hp: 55, atk: 55, def: 50, spa: 45, spd: 65, spe: 55 } } },
  { instanceId: 'c', level: 17, shiny: false, species: { name: 'starly', types: ['normal', 'flying'], baseStats: { hp: 40, atk: 55, def: 30, spa: 30, spd: 30, spe: 60 } } },
  { instanceId: 'd', level: 12, shiny: false, species: { name: 'poochyena', types: ['dark'], baseStats: { hp: 35, atk: 55, def: 35, spa: 30, spd: 30, spe: 35 } } },
];

export function fixtureState(patch = {}) {
  return {
    party: FIXTURE_PARTY,
    biome: 'forest',
    luck: 1,
    efficiency: 1,
    tod: 21.5,
    unlocks: ['route-permit', 'amulet-coin', 'lucky-egg', 'poke-radar', 'auto-battler', 'auto-catch', 'night-shift'],
    upgrades: { 'wage-tier': 4, 'search-tier': 2 },
    tables: ['bulbasaur', 'sprigatito', 'starly'],
    balls: 40,
    progress: { encounters: 0, seconds: 0 },
    ...patch,
  };
}

/** Sums a gap by repeatedly calling `simulate` with `stepS`-second slices. */
export function accumulate(state, totalS, stepS, seed) {
  const acc = {
    money: 0, exp: 0, research: 0, encounters: 0,
    wholeEncounters: 0, wins: 0, catches: 0, shinies: 0, calls: 0,
  };
  // The slice loop shares ONE state object, exactly as drain.js does: a gap resolves
  // against the state it started with.
  let cursor = { ...state, progress: { ...(state.progress ?? { encounters: 0, seconds: 0 }) } };
  let left = totalS;
  while (left > 1e-12) {
    const dt = Math.min(stepS, left);
    const g = simulate(cursor, dt, seed);
    acc.money += g.money; acc.exp += g.exp; acc.research += g.research;
    acc.encounters += g.encounters; acc.wholeEncounters += g.wholeEncounters;
    acc.wins += g.wins; acc.catches += g.catches; acc.shinies += g.shinies;
    acc.calls++;
    // Only `progress` carries forward; everything else is banked by the caller.
    cursor = { ...cursor, progress: g.progress };
    left -= dt;
  }
  return acc;
}

const rel = (a, b) => (a === b ? 0 : Math.abs(a - b) / Math.max(1e-9, Math.abs(a), Math.abs(b)));

/**
 * @returns {{name:string, ok:boolean, detail:string}[]}
 */
export function runSelfTest({ seed = 1337, gapS = 3 * 3600 } = {}) {
  const out = [];
  const check = (name, ok, detail) => out.push({ name, ok: !!ok, detail });

  // 1. Purity: calling twice with the same inputs gives the same output, and the input
  //    state is not mutated.
  {
    const state = fixtureState();
    const before = JSON.stringify(state);
    const a = simulate(state, 600, seed);
    const b = simulate(state, 600, seed);
    check('pure: same inputs, same output', digest(a) === digest(b), `digest ${digest(a)}`);
    check('pure: state not mutated', JSON.stringify(state) === before,
      JSON.stringify(state) === before ? 'state unchanged' : 'STATE WAS MUTATED');
  }

  // 2. Chunk additivity — the property drain.js and offline both depend on.
  {
    const state = fixtureState();
    const whole = simulate(state, gapS, seed);
    const oneSecond = accumulate(state, gapS, 1, seed);
    const coarse = accumulate(state, gapS, 137, seed);

    const dMoney = Math.max(rel(whole.money, oneSecond.money), rel(whole.money, coarse.money));
    const dExp = Math.max(rel(whole.exp, oneSecond.exp), rel(whole.exp, coarse.exp));
    check('additive: money, any chunking', dMoney < 1e-9,
      `rel err ${dMoney.toExponential(2)} over ${oneSecond.calls} slices`);
    check('additive: experience, any chunking', dExp < 1e-9, `rel err ${dExp.toExponential(2)}`);
    check('additive: encounter count exact',
      whole.wholeEncounters === oneSecond.wholeEncounters && whole.wholeEncounters === coarse.wholeEncounters,
      `${whole.wholeEncounters} vs ${oneSecond.wholeEncounters} vs ${coarse.wholeEncounters}`);
    check('additive: wins / catches / shinies exact',
      whole.wins === oneSecond.wins && whole.catches === oneSecond.catches && whole.shinies === oneSecond.shinies &&
      whole.wins === coarse.wins && whole.catches === coarse.catches && whole.shinies === coarse.shinies,
      `${whole.wins}W ${whole.catches}C ${whole.shinies}S`);
  }

  // 3. Determinism across seeds: the same seed repeats, a different seed diverges.
  {
    const state = fixtureState();
    const a = digest(simulate(state, 7200, seed));
    const b = digest(simulate(state, 7200, seed));
    const c = digest(simulate(state, 7200, seed + 1));
    check('deterministic: seed repeats', a === b, `${a} === ${b}`);
    check('deterministic: seeds diverge', a !== c, `${a} vs ${c}`);
  }

  // 4. Party composition and biome actually move the number.
  //
  // **Measured on `exp`, not on `money`** (DECISIONS #69). Money is no longer produced per
  // second by anything — §0 says it is earned by selling what a hunt produced — so a check
  // that compares two biomes' money rates now compares 0 with 0 and passes or fails for no
  // reason. Experience is the channel that still accrues, and it is the one these three
  // properties were ever really about: that the *place* and the *party* matter.
  {
    const forest = production(fixtureState({ biome: 'forest' })).perSecond.exp;
    const city = production(fixtureState({ biome: 'city' })).perSecond.exp;
    const empty = production(fixtureState({ party: [] })).perSecond.exp;
    const full = production(fixtureState()).perSecond.exp;
    check('biome changes production', rel(forest, city) > 0.2,
      `forest ${forest.toFixed(2)}/s vs city ${city.toFixed(2)}/s`);
    check('party changes production', full > empty * 3,
      `party ${full.toFixed(2)}/s vs solo trainer ${empty.toFixed(2)}/s`);
    check('empty party still earns', empty > 0, `${empty.toFixed(3)}/s`);
    check('money is not produced by the clock at all',
      production(fixtureState()).perSecond.money === 0
      && production(fixtureState({ biome: 'city' })).perSecond.money === 0,
      'every biome, every party');
  }

  // 5. Unlocks compose multiplicatively and none of them are on by default.
  {
    const bare = production(fixtureState({ unlocks: [], upgrades: {} })).perSecond;
    const rich = production(fixtureState({ unlocks: Object.keys(UNLOCKS), upgrades: {} })).perSecond;
    // The money and research channels are zero on both sides now, so the multiplier is 0/0.
    // The property is unchanged for the channels that still exist.
    check('unlocks raise every live channel', rich.exp > bare.exp && rich.encounters > bare.encounters,
      `exp x${(rich.exp / bare.exp).toFixed(2)}  enc x${(rich.encounters / bare.encounters).toFixed(2)}`);
    check('a zero channel stays zero however many unlocks are on',
      rich.money === 0 && rich.research === 0, `money ${rich.money}, research ${rich.research}`);
    check('no unlock on by default', production({ party: [] }).applied.length === 0, 'clean state has no multipliers');
  }

  // 6. Offline efficiency is a plain scalar on the whole vector, so `offline` cannot drift.
  {
    const full = simulate(fixtureState({ efficiency: 1 }), 3600, seed);
    const half = simulate(fixtureState({ efficiency: 0.5 }), 3600, seed);
    check('offline efficiency scales linearly', rel(half.passive.money, full.passive.money * 0.5) < 1e-9,
      `${half.passive.money.toFixed(2)} vs ${(full.passive.money * 0.5).toFixed(2)}`);
  }

  // 7. Degenerate inputs do not throw or produce NaN.
  {
    let ok = true, detail = 'empty, negative and absurd elapsed all safe';
    try {
      const cases = [
        [{}, 0], [{}, 1], [{ party: null, biome: 'nope' }, 60], [{ party: [] }, -5],
        [{ party: [{ level: 3 }] }, 10], [fixtureState(), 1e-6],
      ];
      for (const [s, dt] of cases) {
        const g = simulate(s, dt, seed);
        if (!Number.isFinite(g.money) || !Number.isFinite(g.exp) || !Number.isFinite(g.encounters)) {
          ok = false; detail = `NaN from ${JSON.stringify(s).slice(0, 40)} / ${dt}`; break;
        }
        if (g.money < 0) { ok = false; detail = 'negative income'; break; }
      }
    } catch (err) { ok = false; detail = String(err.message ?? err); }
    check('degenerate input is safe', ok, detail);
  }

  // 8. The gap drainer: bounded slices, and the same answer as one offline call.
  {
    const state = fixtureState();
    const drain = makeDrain({ seed, snapshotState: () => state, now: () => 0 });
    drain.queue(gapS, 'selftest');

    const merged = { money: 0, exp: 0, research: 0, encounters: 0, wholeEncounters: 0, wins: 0, catches: 0, shinies: 0 };
    let calls = 0, maxSteps = 0, worstMs = 0, appliedS = 0;
    const BUDGET_STEPS = 512;
    while (drain.pending() > 1e-9 && calls < 500) {
      const r = drain.run({ budgetMs: 4, maxSteps: BUDGET_STEPS });
      calls++;
      maxSteps = Math.max(maxSteps, r.steps);
      worstMs = Math.max(worstMs, r.ms);
      appliedS += r.appliedS;
      if (r.gains) {
        merged.money += r.gains.money; merged.exp += r.gains.exp; merged.research += r.gains.research;
        merged.encounters += r.gains.encounters; merged.wholeEncounters += r.gains.wholeEncounters;
        merged.wins += r.gains.wins; merged.catches += r.gains.catches; merged.shinies += r.gains.shinies;
      }
    }
    const once = simulate(state, gapS, seed);
    check('drain: whole gap applied once', Math.abs(appliedS - gapS) < 1e-6,
      `${appliedS.toFixed(3)}s of ${gapS}s over ${calls} call(s)`);
    check('drain: totals match one offline call',
      rel(merged.money, once.money) < 1e-9 && merged.wholeEncounters === once.wholeEncounters &&
      merged.wins === once.wins && merged.catches === once.catches,
      `money rel err ${rel(merged.money, once.money).toExponential(2)}, ` +
      `${merged.wholeEncounters}/${once.wholeEncounters} encounters, ${merged.wins}/${once.wins} wins`);
    check('drain: step ceiling honoured', maxSteps <= BUDGET_STEPS,
      `worst call ${maxSteps} steps / ${BUDGET_STEPS}`);
    check('drain: 3 h gap costs a few frames', calls <= 8,
      `${calls} call(s), ${drain.stats().steps} steps total`);
  }

  // 9. Idempotence at the boundary: draining nothing is free and safe.
  {
    const state = fixtureState();
    const drain = makeDrain({ seed, snapshotState: () => state, now: () => 0 });
    const empty = drain.run({});
    drain.queue(-5, 'negative');
    drain.queue(NaN, 'nan');
    const stillEmpty = drain.run({});
    check('drain: nothing owed, nothing happens',
      empty.appliedS === 0 && empty.gains === null && stillEmpty.appliedS === 0 && drain.pending() === 0,
      'negative and NaN queues ignored');
  }

  // 10. Every biome in the table is complete, so a hunt cannot silently fall back.
  {
    const bad = Object.entries(BIOMES).filter(([, b]) =>
      !Number.isFinite(b.money) || !Number.isFinite(b.exp) || !Number.isFinite(b.encounters) || !b.favours);
    check('every biome profile complete', bad.length === 0,
      bad.length ? bad.map(([k]) => k).join(', ') : Object.keys(BIOMES).join(', '));
  }

  return out;
}

export function summarise(results) {
  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, ok: passed === results.length };
}

// `node src/idle/selftest.js`
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('selftest.js')) {
  const results = runSelfTest();
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}  —  ${r.detail}`);
  const { passed, total, ok } = summarise(results);
  console.log(`${ok ? '✓' : '✗'} idle selftest: ${passed}/${total}`);
  process.exit(ok ? 0 : 1);
}
