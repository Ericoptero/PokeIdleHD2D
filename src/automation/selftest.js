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
import {
  BUY_COOLDOWN, AUTOMATIONS, automation, defaultRules, defaultSettings,
} from './automations.js';
import { worldFacts, storedFacts, wildFacts, catchRateFor } from './fields.js';
import {
  HEAL_DEFAULTS, REVIVE_DEFAULTS, ETHER_DEFAULTS,
  healChoice, reviveChoice, etherChoice, leadChoice, betweenFor,
} from './duel.js';
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

  // 17 ── the purchase cooldown the brief names.
  //
  // `BUY_COOLDOWN` is not a new mechanism: it is the cadence `restock` already declared, in
  // the engine's own **sim seconds** (`due()`/`mark()`), not wall time. That is what keeps it
  // replayable in a fold and out of the save entirely (DECISIONS #75). Naming it is what makes
  // the brief's word point at something a reader can find.
  results.push(ok('BUY_COOLDOWN is the restock cadence',
    automation('restock').everyS === BUY_COOLDOWN && BUY_COOLDOWN > 0 && BUY_COOLDOWN < 3600,
    `${BUY_COOLDOWN}s`));

  // 18 ── Sell-Lock cannot be outvoted by a ruleset.
  // It is enforced in `planSell` before the rules run, not in `economy.sell()` — the same
  // discipline auto-release's protective rules use, except the player's own instruction does
  // not even get to be reordered (DECISIONS #75).
  results.push(ok('no auto-sell rule reasons about the lock at all',
    defaultRules('sell').every((r) => !/lock/i.test(JSON.stringify(r.when ?? {}))),
    'the lock is a gate, not a rule'));

  // 19 ── the healing ladder, which is the brief's own words in code.
  {
    const bag = { maxpotion: 1, hyperpotion: 1, superpotion: 1, potion: 1 };
    const items = {
      maxpotion: { heal: { hp: 'full' } }, hyperpotion: { heal: { hp: 120 } },
      superpotion: { heal: { hp: 60 } }, potion: { heal: { hp: 20 } },
      revive: { heal: { revive: 0.5 } }, maxrevive: { heal: { revive: 1 } },
      ether: { heal: { pp: 10 } }, maxether: { heal: { pp: 'full' } },
    };
    const at = (p) => ({ hp: p, maxHp: 100, moves: [] });
    const of = (id) => items[id];
    results.push(ok('a critical hit takes the biggest bottle',
      healChoice(HEAL_DEFAULTS, at(8), bag, of)?.item === 'maxpotion', 'hp 8%'));
    results.push(ok('and a scratch takes the smallest',
      healChoice(HEAL_DEFAULTS, at(44), bag, of)?.item === 'potion', 'hp 44%'));
    results.push(ok('above every threshold it does nothing',
      healChoice(HEAL_DEFAULTS, at(60), bag, of) === null, 'hp 60%'));
    // The rule the ordering exists for: a Potion at 10% HP does not prevent the faint it was
    // spent on, so the ladder is dearest-first and never the other way round.
    results.push(ok('the ladder is dearest-first',
      HEAL_DEFAULTS.every((r, i) => i === 0 || r.atPercent > HEAL_DEFAULTS[i - 1].atPercent),
      HEAL_DEFAULTS.map((r) => r.atPercent).join('<')));
    // "…AND whose item is available". Without it a party out of Max Potions stands at 8% HP
    // holding a shelf of Potions it never reaches.
    results.push(ok('an empty rung falls through to the next one that is stocked',
      healChoice(HEAL_DEFAULTS, at(8), { hyperpotion: 2 }, of)?.item === 'hyperpotion',
      'no maxpotion in the bag'));
    results.push(ok('a rung switched off is skipped, not deleted',
      healChoice(HEAL_DEFAULTS.map((r) => (r.item === 'maxpotion' ? { ...r, enabled: false } : r)),
        at(8), bag, of)?.item === 'hyperpotion'));
    results.push(ok('a fainted Pokemon is never healed',
      healChoice(HEAL_DEFAULTS, { hp: 0, maxHp: 100, moves: [] }, bag, of) === null));

    // Revival.
    results.push(ok('revive before max revive',
      reviveChoice(REVIVE_DEFAULTS, { hp: 0, maxHp: 100 }, { revive: 1, maxrevive: 1 }, of)?.item === 'revive'));
    results.push(ok('and max revive when that is all there is',
      reviveChoice(REVIVE_DEFAULTS, { hp: 0, maxHp: 100 }, { maxrevive: 1 }, of)?.item === 'maxrevive'));
    results.push(ok('a conscious member is never revived',
      reviveChoice(REVIVE_DEFAULTS, { hp: 12, maxHp: 100 }, { revive: 1 }, of) === null));
    results.push(ok('"specific" only raises the member it names',
      reviveChoice({ ...REVIVE_DEFAULTS, mode: 'specific', member: 'a#1' },
        { hp: 0, maxHp: 100, instanceId: 'b#2' }, { revive: 1 }, of) === null));

    // PP. The HIGHEST-PRIORITY move, not the emptiest — that is the brief's wording and the
    // right target, because the top move is the one `choose` reaches for every turn.
    const mon = {
      hp: 50, maxHp: 100, priority: ['surf'],
      moves: [{ id: 'tackle', pp: 0, maxPp: 35 }, { id: 'surf', pp: 0, maxPp: 15 }],
    };
    results.push(ok('the ether goes into the top-priority move',
      etherChoice(ETHER_DEFAULTS, mon, { ether: 1 }, of)?.moveId === 'surf'));
    results.push(ok('…and not while it still has PP',
      etherChoice(ETHER_DEFAULTS, { ...mon, moves: [{ id: 'surf', pp: 9, maxPp: 15 }] },
        { ether: 1 }, of) === null));
    results.push(ok('with no ether in the bag it says nothing, and the move is skipped',
      etherChoice(ETHER_DEFAULTS, mon, {}, of) === null));

    // The composition, in the brief's order.
    const plan = betweenFor({ heal: HEAL_DEFAULTS, revive: REVIVE_DEFAULTS, ether: ETHER_DEFAULTS },
      { revive: 1, maxpotion: 1, ether: 1 }, of);
    results.push(ok('a fallen member is revived before anything else is considered',
      plan({ a: { hp: 0, maxHp: 100, moves: [] } })[0]?.kind === 'revive'));
    results.push(ok('one action per turn, never three',
      plan({ a: { ...mon, hp: 5 } }).length === 1, 'a turn is a turn'));
  }

  // 20 ── Auto-Lead: offence first, then defence, then health.
  {
    const chart = { water: { fire: 2, grass: 0.5 }, grass: { water: 2, fire: 0.5 }, fire: { grass: 2, water: 0.5 } };
    const eff = (t, ds) => (ds ?? []).reduce((n, d) => n * (chart[t]?.[d] ?? 1), 1);
    const mk = (id, type, hp, moveType) => ({
      instanceId: id, hp, maxHp: 100, species: { types: [type] },
      moves: [{ id: 'm', pp: 10, type: moveType }],
    });
    const party = [
      mk('grass#1', 'grass', 100, 'grass'),
      mk('fire#2', 'fire', 100, 'fire'),
      mk('water#3', 'water', 100, 'water'),
    ];
    const deps = { effectiveness: eff, typesOf: (m) => m.species.types, movesOf: (m) => m.moves };
    // Against a Water wild, the Grass member's move is 2x and it also resists water back.
    results.push(ok('it sends the type that wins the matchup',
      leadChoice(party, { types: ['water'] }, deps, { mode: 'auto' }) === 'grass#1'));
    results.push(ok('…and against fire it sends the water one',
      leadChoice(party, { types: ['fire'] }, deps, { mode: 'auto' }) === 'water#3'));
    // HP is a TIEBREAK, so it must not outrank a better matchup.
    const hurt = [mk('grass#1', 'grass', 5, 'grass'), mk('fire#2', 'fire', 100, 'fire')];
    results.push(ok('a bad matchup at full health still loses to a good one at 5%',
      leadChoice(hurt, { types: ['water'] }, deps, { mode: 'auto' }) === 'grass#1'));
    // …but it does break a tie between equals.
    const tie = [mk('a#1', 'fire', 40, 'fire'), mk('b#2', 'fire', 90, 'fire')];
    results.push(ok('between equals it sends the healthier one',
      leadChoice(tie, { types: ['grass'] }, deps, { mode: 'auto' }) === 'b#2'));
    results.push(ok('a fainted member is never eligible',
      leadChoice([mk('down#1', 'grass', 0, 'grass'), mk('up#2', 'fire', 50, 'fire')],
        { types: ['water'] }, deps, { mode: 'auto' }) === 'up#2'));
    results.push(ok('an all-fainted party has no lead at all',
      leadChoice([mk('x#1', 'grass', 0, 'grass')], { types: ['water'] }, deps, { mode: 'auto' }) === null));
    results.push(ok('manual sends the member the player assigned',
      leadChoice(party, { types: ['water'], species: 'squirtle' }, deps,
        { mode: 'manual', assign: { squirtle: 'fire#2' } }) === 'fire#2'));
  }

  // 21 ── none of the four runs on a cadence.
  // `PASSES` is the round-robin tick and these run between turns or at engagement; on a cadence
  // they would fire against no fight at all, which is the trap `hunt` and `catch` sit in.
  results.push(ok('the in-fight automations declare no cadence',
    ['heal', 'revive', 'ether', 'lead'].every((id) => automation(id).everyS === 0),
    ['heal', 'revive', 'ether', 'lead'].map((id) => `${id}:${automation(id).everyS}`).join(' ')));

  // 22 ── a builtin added after a save reaches it, at the end.
  {
    const engine = makeEngine();
    engine.restore({ automations: { sell: { unlocked: true, enabled: true, rules: [
      { id: 'sell-treasure', name: 'mine', builtin: true, when: null, then: 'sell' },
    ] } } });
    const got = engine.rules('sell');
    results.push(ok('the player\'s own rule keeps its place at the top',
      got[0].id === 'sell-treasure' && got[0].name === 'mine'));
    results.push(ok('…and every builtin it had not seen is appended after it',
      defaultRules('sell').every((r) => got.some((g) => g.id === r.id)),
      `${got.length} rules`));
  }

  // 23 ── Auto-Buy spends by class, not by price.
  //
  // The brief: *Healing -> Revival -> PP restoration -> Poké Balls*, and "must not simply
  // purchase the cheapest item first". Rule order alone could not express it — three of those
  // four classes are `category: 'medicine'`, so one medicine rule ordered them by price and a
  // thin wallet bought twenty Potions instead of the Max Potion that keeps a party standing
  // (DECISIONS #78).
  {
    const s2 = defaultSettings('restock');
    results.push(ok('the budget order is the brief\'s own',
      JSON.stringify(s2.categoryOrder) === JSON.stringify(['heal', 'revive', 'pp', 'ball']),
      JSON.stringify(s2.categoryOrder)));
    results.push(ok('and the targets are per item, not per rule',
      s2.targets && s2.targets.potion === 10 && s2.targets.ether === 5 && s2.targets.pokeball === 20,
      JSON.stringify(s2.targets)));
    // A default that is a shared object handed to a save is a default the player cannot edit —
    // or worse, one they can edit for every save in the tab.
    const a = defaultSettings('restock');
    const b = defaultSettings('restock');
    a.targets.potion = 99;
    results.push(ok('every save gets its own copy of a map default', b.targets.potion === 10,
      `${b.targets.potion}`));
  }

  // 24 ── the ball ladder is a preference, and Advanced is per species.
  {
    const s2 = defaultSettings('ball');
    results.push(ok('simple is the default mode', s2.mode === 'simple', String(s2.mode)));
    results.push(ok('the shipped ladder is dearest-first',
      JSON.stringify(s2.ladder) === JSON.stringify(['ultraball', 'greatball', 'pokeball']),
      JSON.stringify(s2.ladder)));
    results.push(ok('advanced starts empty, so it behaves exactly like simple until told otherwise',
      s2.perSpecies && Object.keys(s2.perSpecies).length === 0));
    // Shape-checked on restore, because a save is a file a player can edit and a malformed
    // ladder would be a silent no-op at the moment a shiny appeared.
    const e = makeEngine();
    e.restore({ automations: { ball: { unlocked: true, enabled: true, settings: {
      ladder: ['greatball', 7, null], perSpecies: { gible: ['ultraball'], bad: 'nope' },
    } } } });
    const got = e.settings('ball');
    results.push(ok('a ladder keeps only the ids it can use',
      JSON.stringify(got.ladder) === JSON.stringify(['greatball']), JSON.stringify(got.ladder)));
    results.push(ok('…and a per-species map drops the rows that are not ladders',
      JSON.stringify(got.perSpecies) === JSON.stringify({ gible: ['ultraball'] }),
      JSON.stringify(got.perSpecies)));
  }

  // 25 ── a move slot carries no type, and the lead rule has to survive that.
  //
  // **The check that would have caught DECISIONS #80 and did not.** Check 20 above builds its
  // party with `moves: [{ id, pp, type }]` — a shape no `pokemon` instance has. A real slot is
  // `{ id, pp, maxPp }`, so `leadChoice` read `undefined` for every type, scored every member at
  // the offensive floor, and fell through to the health tiebreak: against a Grass wild, with a
  // Tepig holding Ember on the bench, it sent the Snivy. The stub was more generous than the
  // game and the test passed on it.
  //
  // So this one uses the REAL slot shape and resolves types the way `automation.duel()` does.
  {
    const chart = { fire: { grass: 2 }, grass: { fire: 0.5, water: 2 }, water: { fire: 2, grass: 0.5 } };
    const eff = (t, ds) => (ds ?? []).reduce((n, d) => n * (chart[t]?.[d] ?? 1), 1);
    const TABLE = { ember: { t: 'fire' }, vinewhip: { t: 'grass' }, watergun: { t: 'water' }, tackle: { t: 'normal' } };
    const mk = (id, type, moves) => ({
      instanceId: id, hp: 40, maxHp: 40, species: { types: [type] },
      // The shape `pokemon/instance.js` actually stores: an id and its PP, and nothing else.
      moves: moves.map((x) => ({ id: x, pp: 10, maxPp: 10 })),
    });
    const bench = [
      mk('oshawott#1', 'water', ['tackle', 'watergun']),
      mk('snivy#2', 'grass', ['tackle', 'vinewhip']),
      mk('tepig#3', 'fire', ['tackle', 'ember']),
    ];
    const resolved = {
      effectiveness: eff,
      typesOf: (m2) => m2.species.types,
      movesOf: (m2) => m2.moves.map((x) => ({ ...x, type: TABLE[x.id]?.t ?? null })),
    };
    results.push(ok('with types resolved, a Grass wild is met by the Fire type',
      leadChoice(bench, { types: ['grass'] }, resolved, { mode: 'auto' }) === 'tepig#3',
      String(leadChoice(bench, { types: ['grass'] }, resolved, { mode: 'auto' }))));

    /**
     * And the failure mode itself, isolated.
     *
     * The bench above cannot prove it: all three differ in *defence* too, so the right answer
     * comes out either way and the first fixture agreed with the broken code by luck — which is
     * exactly how the original defect survived. So: three members of the **same type**, whose
     * defence against the wild is therefore identical, differing only in what their moves are
     * made of. Resolved, the Fire one is sent. Unresolved, every offence is the floor, nothing
     * separates them, and the first in line goes — the behaviour that shipped.
     */
    const same = [
      mk('a#1', 'normal', ['watergun']),
      mk('b#2', 'normal', ['vinewhip']),
      mk('c#3', 'normal', ['ember']),
    ];
    results.push(ok('offence alone picks the Fire mover against a Grass wild',
      leadChoice(same, { types: ['grass'] }, resolved, { mode: 'auto' }) === 'c#3'));
    const raw = { ...resolved, movesOf: (m2) => m2.moves };
    results.push(ok('…and with unresolved slots it falls to first-in-line, which is the bug',
      leadChoice(same, { types: ['grass'] }, raw, { mode: 'auto' }) === 'a#1'));
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
