/**
 * The invariants, runnable with no browser:
 *
 *     node src/automation/selftest.js
 *
 * Everything here is a property that would be expensive to notice by looking at a
 * screenshot: that no automation is on until it is bought and switched on, that a
 * protective rule cannot be outvoted, that two identical runs produce identical audit
 * logs, that the ball optimiser really does disagree with the multiplier table, and that
 * evaluating a ruleset over a full box is cheap enough to do on a cadence.
 *
 * The pure half needs nothing but this folder. `runSelfTest` adds the live checks that
 * need a running game, and the showcase prints both.
 */

import { makeEngine } from './engine.js';
import { compileRuleset, validateRule, normaliseRule } from './rules.js';
import { AUTOMATIONS, automation, defaultRules } from './automations.js';
import { worldFacts, storedFacts, wildFacts, catchRateFor } from './fields.js';
import { chooseBall, rankBalls, DEFAULT_SETTINGS as BALL_DEFAULTS } from './ball.js';

const ok = (name, pass, detail = '') => ({ name, ok: !!pass, detail: String(detail) });

/**
 * A stand-in ball line for the optimiser checks. Deliberately *not* imported from
 * `economy` — a self-test that shares its inputs with the thing it is testing proves
 * nothing, and a cross-module import would fail the seams check anyway. The capture curve
 * is the same Gen 3/4 shape `economy/items.js` documents.
 */
function stubEvaluator(counts = {}) {
  const line = [
    { id: 'pokeball', name: 'Poké Ball', price: 200, currency: 'money', mult: 1 },
    { id: 'greatball', name: 'Great Ball', price: 600, currency: 'money', mult: 1.5 },
    { id: 'ultraball', name: 'Ultra Ball', price: 1200, currency: 'money', mult: 2 },
    { id: 'quickball', name: 'Quick Ball', price: 15, currency: 'bp', mult: 5 },
    { id: 'masterball', name: 'Master Ball', price: 500, currency: 'bp', mult: 255 },
  ];
  const odds = ({ ball, catchRate = 45, hpFraction = 0.35 }) => {
    const def = line.find((b) => b.id === ball);
    if (!def) return 0;
    if (def.mult >= 255) return 1;
    const a = ((3 - 2 * hpFraction) / 3) * catchRate * def.mult;
    if (a >= 255) return 1;
    const shake = 65536 / Math.pow(255 / a, 3 / 16);
    return Math.min(1, Math.max(0, Math.pow(shake / 65536, 4)));
  };
  return {
    line,
    balls: () => line.map((b) => ({ ...b, count: counts[b.id] ?? 10 })),
    multiplier: (id) => line.find((b) => b.id === id)?.mult ?? 0,
    odds,
  };
}

/** A deterministic, ctx-free box of duplicates for the release and budget checks. */
function fakeBox(n = 300) {
  const species = ['zubat', 'geodude', 'rattata', 'pidgey', 'magikarp', 'caterpie'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const key = species[i % species.length];
    // A fixed integer hash, not an RNG: the box has to be the same on every machine.
    const h = ((i * 2654435761) >>> 0) / 4294967296;
    out.push({
      uid: `${key}#${i}`,
      instanceId: `${key}-${i}`,
      species: key,
      display: key,
      dexId: 41 + (i % 6),
      gen: 1,
      types: ['poison', 'flying'],
      bst: 245 + (i % 7) * 30,
      level: 3 + Math.floor(h * 40),
      shiny: i % 97 === 0,
      ivs: { hp: 10, atk: 12, def: 8, spa: 20, spd: 5, spe: 3 },
      ivTotal: Math.floor(h * 186),
      favourite: i % 61 === 0,
      ordinal: i,
      simTime: i * 3,
      origin: 'wild',
      ball: 'pokeball',
    });
  }
  return out;
}

const WORLD = worldFacts({ biome: 'forest', tod: 21, money: 120000, research: 800, bp: 40, shards: 25, ballsInBag: 63, boxFree: 402, boxUsed: 558, dexCaught: 74 });

// ---------------------------------------------------------------------------
// The pure checks
// ---------------------------------------------------------------------------

export function pureChecks() {
  const results = [];

  // 1 ── every shipped rule validates against the schema its own automation declares.
  {
    const bad = [];
    for (const def of AUTOMATIONS) {
      const cs = compileRuleset(defaultRules(def.id), {
        kind: def.kind, actions: def.actions, defaultAction: def.defaultAction,
      });
      for (const e of cs.errors) bad.push(`${def.id}/${e}`);
    }
    results.push(ok('every shipped rule validates', bad.length === 0,
      bad.length ? bad.slice(0, 3).join('; ') : `${AUTOMATIONS.length} automations, ${AUTOMATIONS.reduce((n, a) => n + a.rules.length, 0)} rules`));
  }

  // 2 ── nothing is on by default (ARCHITECTURE §5.11).
  {
    const engine = makeEngine();
    const on = AUTOMATIONS.filter((a) => engine.isActive(a.id) || engine.isUnlocked(a.id) || engine.isEnabled(a.id));
    results.push(ok('nothing is unlocked or enabled by default', on.length === 0,
      on.length ? on.map((a) => a.id).join(', ') : `${AUTOMATIONS.length} automations, all locked`));
  }

  // 3 ── unlocking does not enable; enabling a locked automation does nothing.
  {
    const engine = makeEngine();
    engine.enable('release', true);
    const enabledWhileLocked = engine.isEnabled('release');
    engine.markUnlocked('release', true);
    const activeAfterUnlock = engine.isActive('release');
    engine.enable('release', true);
    results.push(ok('unlock and enable are two separate steps',
      !enabledWhileLocked && !activeAfterUnlock && engine.isActive('release'),
      `locked→enable ${enabledWhileLocked ? 'took' : 'refused'}; unlocked→${activeAfterUnlock ? 'auto-on' : 'still off'}`));
  }

  // 4 ── operator truth table, every operator exercised at least once.
  {
    const cases = [
      [{ field: 'level', op: 'gt', value: 20 }, { level: 21 }, true],
      [{ field: 'level', op: 'gte', value: 20 }, { level: 20 }, true],
      [{ field: 'level', op: 'lt', value: 20 }, { level: 20 }, false],
      [{ field: 'level', op: 'lte', value: 20 }, { level: 20 }, true],
      [{ field: 'level', op: 'between', value: [10, 20] }, { level: 15 }, true],
      [{ field: 'level', op: 'between', value: [10, 20] }, { level: 21 }, false],
      [{ field: 'species', op: 'eq', value: 'Zubat' }, { species: 'zubat' }, true],
      [{ field: 'species', op: 'ne', value: 'zubat' }, { species: 'zubat' }, false],
      [{ field: 'species', op: 'in', value: ['zubat', 'geodude'] }, { species: 'geodude' }, true],
      [{ field: 'species', op: 'notIn', value: ['zubat'] }, { species: 'geodude' }, true],
      [{ field: 'types', op: 'has', value: 'flying' }, { types: ['poison', 'flying'] }, true],
      [{ field: 'types', op: 'hasAny', value: ['ice', 'flying'] }, { types: ['poison', 'flying'] }, true],
      [{ field: 'types', op: 'hasNone', value: ['ice', 'dragon'] }, { types: ['poison', 'flying'] }, true],
      [{ field: 'shiny', op: 'isTrue' }, { shiny: true }, true],
      [{ field: 'shiny', op: 'isFalse' }, { shiny: true }, false],
      [{ all: [{ field: 'level', op: 'gte', value: 5 }, { field: 'shiny', op: 'isFalse' }] }, { level: 9, shiny: false }, true],
      [{ any: [{ field: 'level', op: 'gte', value: 50 }, { field: 'shiny', op: 'isTrue' }] }, { level: 9, shiny: true }, true],
      [{ not: { field: 'shiny', op: 'isTrue' } }, { level: 9, shiny: true }, false],
    ];
    let bad = null;
    for (const [when, facts, want] of cases) {
      const cs = compileRuleset([{ id: 'x', when, then: 'release' }], {
        kind: 'stored', actions: automation('release').actions, defaultAction: 'keep',
      });
      const got = cs.evaluate(facts).action === 'release';
      if (got !== want) { bad = `${JSON.stringify(when)} on ${JSON.stringify(facts)} gave ${got}`; break; }
    }
    results.push(ok('operator truth table', !bad, bad ?? `${cases.length} cases across 14 operators`));
  }

  // 5 ── a protective rule cannot be outvoted, only reordered.
  {
    const def = automation('release');
    const cs = compileRuleset(defaultRules('release'), { kind: 'stored', actions: def.actions, defaultAction: 'keep' });
    const shinyDupe = storedFacts(
      { species: 'zubat', level: 9, shiny: true, ivTotal: 20, ivs: {}, origin: 'wild' },
      WORLD, { copies: 9, rank: 7, value: 400, ageS: 9000 },
    );
    const plainDupe = storedFacts(
      { species: 'zubat', level: 9, shiny: false, ivTotal: 20, ivs: {}, origin: 'wild' },
      WORLD, { copies: 9, rank: 7, value: 40, ageS: 9000 },
    );
    const a = cs.evaluate(shinyDupe);
    const b = cs.evaluate(plainDupe);
    // Now reorder: put the release rule first and the shiny is no longer safe. That is the
    // point — precedence is the list order, and it is the player's to change.
    const moved = defaultRules('release');
    moved.unshift(moved.splice(moved.findIndex((r) => r.id === 'rel-dupes'), 1)[0]);
    const cs2 = compileRuleset(moved, { kind: 'stored', actions: def.actions, defaultAction: 'keep' });
    const c = cs2.evaluate(shinyDupe);
    results.push(ok('protections win by order, and only by order',
      a.action === 'keep' && b.action === 'release' && c.action === 'release',
      `shiny→${a.action} (${a.ruleId}), plain→${b.action} (${b.ruleId}), reordered shiny→${c.action}`));
  }

  // 6 ── the grace period keeps a fresh catch out of the release plan.
  {
    const def = automation('release');
    const cs = compileRuleset(defaultRules('release'), { kind: 'stored', actions: def.actions, defaultAction: 'keep' });
    const fresh = storedFacts({ species: 'zubat', level: 9, shiny: false, ivTotal: 20, ivs: {} }, WORLD,
      { copies: 9, rank: 7, value: 40, ageS: 30 });
    const old = storedFacts({ species: 'zubat', level: 9, shiny: false, ivTotal: 20, ivs: {} }, WORLD,
      { copies: 9, rank: 7, value: 40, ageS: 130 });
    results.push(ok('the two-minute grace period holds',
      cs.evaluate(fresh).action === 'keep' && cs.evaluate(old).action === 'release',
      `30 s → ${cs.evaluate(fresh).action}, 130 s → ${cs.evaluate(old).action}`));
  }

  // 7 ── validation rejects nonsense instead of silently ignoring it.
  {
    const cases = [
      [{ when: { field: 'nonsense', op: 'gt', value: 1 }, then: 'keep' }, 'unknown field'],
      [{ when: { field: 'shiny', op: 'gt', value: 1 }, then: 'keep' }, 'operator on the wrong type'],
      [{ when: { field: 'origin', op: 'eq', value: 'nowhere' }, then: 'keep' }, 'value outside the enum'],
      [{ when: { field: 'level', op: 'gt', value: 'tall' }, then: 'keep' }, 'non-numeric value'],
      [{ when: { field: 'level', op: 'gt', value: 1 }, then: 'explode' }, 'unknown action'],
    ];
    const missed = cases.filter(([rule]) => validateRule(rule, { kind: 'stored', actions: automation('release').actions }).length === 0);
    // And an invalid rule must be inert, not wrong: it never matches.
    const cs = compileRuleset([{ id: 'bad', when: { field: 'nonsense', op: 'gt', value: 1 }, then: 'release' }],
      { kind: 'stored', actions: automation('release').actions, defaultAction: 'keep' });
    const inert = cs.evaluate({ level: 99 }).action === 'keep';
    results.push(ok('bad rules are caught and are inert', missed.length === 0 && inert,
      missed.length ? `missed: ${missed[0][1]}` : `${cases.length} kinds rejected; an invalid rule never matches`));
  }

  // 8 ── the ball optimiser disagrees with the multiplier table, and is right to.
  {
    const ev = stubEvaluator();
    const settings = { ...BALL_DEFAULTS, bpWeight: 2500, reserve: { masterball: 1 } };
    // An easy target: a Poké Ball already catches it most of the time, so the Quick Ball's
    // 5× buys a few percent for 187× the money. Max-multiplier says Quick Ball; cost per
    // Pokémon actually caught says Poké Ball.
    const easy = { catchRate: 190, hpFraction: 0.35, context: {} };
    const value = chooseBall(ev, easy, 'value', settings);
    const table = rankBalls(ev, easy, settings);
    const byMultiplier = table.filter((r) => r.id !== 'masterball').sort((a, b) => b.multiplier - a.multiplier)[0];
    results.push(ok('value tier beats the multiplier table',
      value.ball === 'pokeball' && byMultiplier.id === 'quickball',
      `optimiser → ${value.ball} (₽${Math.round(value.expected)}/catch); multiplier table → ${byMultiplier.id} (₽${Math.round(byMultiplier.expected)}/catch)`));
  }

  // 9 ── secure takes the cheapest ball that clears the floor *within* the spend cap.
  {
    const ev = stubEvaluator();
    const settings = { ...BALL_DEFAULTS, bpWeight: 2500, oddsFloor: 0.9, maxSpend: 25000, reserve: { masterball: 1 } };
    const target = { catchRate: 190, hpFraction: 0.35, context: {} };
    const secure = chooseBall(ev, target, 'secure', settings);
    const rows = rankBalls(ev, target, settings);
    const clearing = rows.filter((r) => r.odds >= settings.oddsFloor && r.id !== 'masterball');
    const affordable = clearing.filter((r) => r.cost <= settings.maxSpend).sort((a, b) => a.cost - b.cost);
    const rejected = clearing.filter((r) => r.cost > settings.maxSpend);
    results.push(ok('secure buys the cheapest ball that clears the floor, inside the cap',
      affordable.length > 0 && rejected.length > 0 && secure.ball === affordable[0].id,
      `${clearing.length} balls clear 90%; ${rejected.map((r) => r.id).join(', ')} rejected over the ₽${settings.maxSpend.toLocaleString('en-US')} cap; took ${secure.ball} at ₽${Math.round(secure.cost)} (${(secure.odds * 100).toFixed(1)}%)`));
  }

  // 10 ── the Master Ball is reserved, and only released for a target nothing else reaches.
  {
    const settings = { ...BALL_DEFAULTS, reserve: { masterball: 1 }, masterFloor: 0.25 };
    const hard = { catchRate: 3, hpFraction: 0.35, context: {} };
    const withOne = chooseBall(stubEvaluator({ masterball: 1 }), hard, 'secure', settings);
    const withTwo = chooseBall(stubEvaluator({ masterball: 2 }), hard, 'secure', settings);
    const easyTwo = chooseBall(stubEvaluator({ masterball: 2 }), { catchRate: 190, hpFraction: 0.35, context: {} }, 'secure', settings);
    results.push(ok('the Master Ball is reserved and gated',
      withOne.ball !== 'masterball' && withTwo.ball === 'masterball' && easyTwo.ball !== 'masterball',
      `1 held → ${withOne.ball}; 2 held → ${withTwo.ball}; 2 held, easy target → ${easyTwo.ball}`));
  }

  // 11 ── two identical runs produce byte-identical audit logs.
  {
    const script = (engine) => {
      engine.markUnlocked('release', true);
      engine.enable('release', true);
      engine.configure('release', { maxPerRun: 7, keepOrder: 'level' });
      engine.addRule('release', { id: 'user-1', name: 'Release Magikarp', when: { field: 'species', op: 'eq', value: 'magikarp' }, then: 'release' }, 0);
      for (let i = 0; i < 25; i++) {
        engine.log({ at: i * 1.5, automation: 'release', action: 'release', subject: `zubat#${i}`, rule: 'rel-dupes', detail: `₽${i * 13}` });
      }
      engine.mark('release', 40);
      return JSON.stringify(engine.history());
    };
    const a = script(makeEngine());
    const b = script(makeEngine());
    results.push(ok('two identical runs produce identical audit logs', a === b,
      `${JSON.parse(a).length} entries, ${a.length} bytes, ${a === b ? 'identical' : 'DIFFER'}`));
  }

  // 12 ── the save slice round-trips, including edited rules and settings.
  {
    const before = makeEngine();
    before.markUnlocked('sell', true);
    before.enable('sell', true);
    before.configure('sell', { maxPerRun: 3 });
    before.addRule('sell', { id: 'u1', name: 'mine', when: { field: 'count', op: 'gt', value: 4 }, then: 'sell', args: { keep: 2 } });
    before.moveRule('sell', 'u1', 0);
    const slice = JSON.parse(JSON.stringify(before.serialize()));
    const after = makeEngine();
    after.restore(slice);
    const same = JSON.stringify(after.serialize()) === JSON.stringify(before.serialize());
    results.push(ok('the save slice round-trips', same,
      same ? `${Object.keys(slice.automations).length} automations, rules and settings preserved`
        : 'serialize→restore→serialize differs'));
  }

  // 13 ── settings are coerced and clamped; a UI cannot put a string in a number.
  {
    const engine = makeEngine();
    engine.configure('ball', { oddsFloor: '2', bpWeight: 'lots', reserveMaster: -4 });
    const s = engine.settings('ball');
    results.push(ok('settings are coerced and clamped',
      s.oddsFloor === 1 && s.bpWeight === 2500 && s.reserveMaster === 0,
      `oddsFloor "2"→${s.oddsFloor}, bpWeight "lots"→${s.bpWeight}, reserveMaster -4→${s.reserveMaster}`));
  }

  // 14 ── the evaluation budget: a full box, on a cadence, must be nearly free.
  {
    const def = automation('release');
    const cs = compileRuleset(defaultRules('release'), { kind: 'stored', actions: def.actions, defaultAction: 'keep' });
    const box = fakeBox(900);
    const facts = box.map((e, i) => storedFacts(e, WORLD, { copies: 150, rank: (i % 150) + 1, value: 60, ageS: 4000 }));
    // Warm the JIT, then measure.
    for (const f of facts) cs.evaluate(f);
    const t0 = performance.now();
    const rounds = 20;
    let sink = 0;
    for (let r = 0; r < rounds; r++) for (const f of facts) sink += cs.evaluate(f).action.length;
    const ms = performance.now() - t0;
    const per = (ms * 1000) / (rounds * facts.length);
    results.push(ok('evaluating a full box is cheap', per < 5 && sink > 0,
      `${(rounds * facts.length).toLocaleString('en-US')} evaluations in ${ms.toFixed(1)} ms — ${per.toFixed(2)} µs each, ${(ms / rounds).toFixed(2)} ms per 900-slot pass`));
  }

  // 15 ── the capture-rate proxy is monotone and lands where it says it does.
  {
    const points = [195, 300, 450, 500, 600, 680];
    const rates = points.map(catchRateFor);
    const monotone = rates.every((r, i) => i === 0 || r <= rates[i - 1]);
    results.push(ok('the capture-rate proxy is monotone', monotone && rates[0] > 200 && rates.at(-1) <= 10,
      points.map((p, i) => `${p}→${rates[i]}`).join('  ')));
  }

  // 16 ── a wild fact object carries everything the wild schema promises.
  {
    const facts = wildFacts({ species: { name: 'gengar', id: 94, gen: 1, types: ['ghost', 'poison'], bst: 500 }, level: 34, shiny: false, newSpecies: true, value: 4080 }, WORLD);
    const missing = automation('catch').rules
      .flatMap((r) => leafFields(r.when))
      .filter((f) => !(f in facts));
    results.push(ok('every field the shipped rules test is present in the facts', missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `${Object.keys(facts).length} fields built`));
  }

  return results;
}

function leafFields(when, out = []) {
  if (!when || typeof when !== 'object') return out;
  if (Array.isArray(when.all)) { when.all.forEach((c) => leafFields(c, out)); return out; }
  if (Array.isArray(when.any)) { when.any.forEach((c) => leafFields(c, out)); return out; }
  if ('not' in when) return leafFields(when.not, out);
  if (when.field) out.push(when.field);
  return out;
}

// ---------------------------------------------------------------------------
// The live checks
// ---------------------------------------------------------------------------

/**
 * Everything in `pureChecks`, plus the properties that need a running game: that the ball
 * optimiser agrees with `economy`'s own odds, that a release preview never touches
 * storage, and that the flags this module asserts on `idle` really are set.
 */
export function runSelfTest({ api, ctx } = {}) {
  const results = pureChecks();
  if (!api || !ctx) return { ok: results.every((r) => r.ok), results };

  const isLive = (m) => !!m && m.__missing === undefined;
  const economy = ctx.get('economy');
  const collection = ctx.get('collection');
  const idle = ctx.get('idle');

  // 17 ── the optimiser's odds are `economy`'s odds, not a private copy of the formula.
  if (isLive(economy) && typeof economy.catchOdds === 'function') {
    const table = api.ballTable({ species: 'gengar', level: 34, shiny: false });
    const row = table.find((r) => r.id === 'greatball');
    const direct = economy.catchOdds({
      ball: 'greatball', catchRate: catchRateFor(500), hpFraction: api.settings('ball').hpFraction, context: {},
    });
    results.push(ok('the optimiser reads economy\'s own capture maths',
      !!row && Math.abs(row.odds - direct) < 1e-9,
      row ? `great ball vs gengar: ${(row.odds * 100).toFixed(2)}% here, ${(direct * 100).toFixed(2)}% from economy` : 'no great ball row'));
  }

  // 18 ── a preview is pure: the box is the same size before and after.
  if (isLive(collection) && typeof collection.count === 'function') {
    const before = collection.count();
    api.preview('release');
    api.preview('sell');
    api.preview('restock');
    const after = collection.count();
    results.push(ok('previews touch nothing', before === after, `${before} stored before and after three dry runs`));
  }

  // 19 ── the flags this module asserts on `idle` are the flags `idle` reports.
  if (isLive(idle) && typeof idle.has === 'function') {
    const want = AUTOMATIONS.filter((a) => a.idleUnlock);
    const wrong = want.filter((a) => !!idle.has(a.idleUnlock) !== api.isActive(a.id));
    results.push(ok('idle\'s flags match the automations that are on', wrong.length === 0,
      wrong.length ? wrong.map((a) => `${a.id}→${a.idleUnlock}`).join(', ')
        : want.map((a) => `${a.idleUnlock}:${api.isActive(a.id) ? 'on' : 'off'}`).join('  ')));
  }

  return { ok: results.every((r) => r.ok), results };
}

// ---------------------------------------------------------------------------
// Node entry point
// ---------------------------------------------------------------------------

const isNodeMain = typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && process.argv[1]
  && import.meta.url.endsWith(process.argv[1].split('/').pop());

if (isNodeMain) {
  const results = pureChecks();
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} invariants hold`);
  if (typeof process !== 'undefined' && failed) process.exitCode = 1;
}
