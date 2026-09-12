#!/usr/bin/env node
/**
 * Property checks for `src/battle/`, run under plain Node by `tools/seams/run.js` rule 6.
 *
 *   node src/battle/selftest.js
 *
 * These are the checks a screenshot cannot make. Three kinds:
 *
 *   1. **Golden values** — literals recorded from seed 1337. Comparing two live calls to each
 *      other cannot catch a reordered draw sequence, because both calls reorder identically
 *      and both agree; only literals can (DECISIONS #35, and #61(g) for the turn's own order).
 *   2. **Landmarks** — thirty type-chart pairs and two damage calculations, so a transcription
 *      slip in a 324-entry table is caught by something other than a player losing a fight
 *      they should have won.
 *   3. **Invariants over a sweep** — PP never negative, no battle stalls, every fight
 *      reproducible.
 *
 * It reads the two committed snapshots off disk, which is the same data the browser fetches:
 * `moves.js` is handed parsed objects and never fetches anything itself, precisely so this
 * file can exist.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as MOVES from './moves.js';
import { effectiveness, TYPES, TYPE_INK, typeColour } from './types.js';
import { statsOf, expAtLevel, levelForExp, expYield, stageMultiplier } from './stats.js';
import {
  makeCombatant, resolve, stepper, applyAction, damageOf, streamFor, STREAM_ROOT, MAX_BETWEEN,
} from './engine.js';
import { strikesOf, describeStrike } from './strike.js';
import { makeRng } from '../core/rng.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const gen = (f) => JSON.parse(readFileSync(join(REPO, 'public', 'generated', f), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); return !!ok };
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// --- the data ---------------------------------------------------------------
const speciesTable = gen('species.json');
MOVES.load({ moves: gen('moves.json'), learnsets: gen('learnsets.json') });
const by = Object.fromEntries(speciesTable.map((s) => [s.name, s]));

check('1. moves loaded', MOVES.moveCount() > 600, `${MOVES.moveCount()} moves`);
check('2. every shipped species has a learnset', speciesTable.every((s) => MOVES.learnset(s.name).length > 0),
  `${speciesTable.filter((s) => !MOVES.learnset(s.name).length).length} without one`);
check('3. every species carries a capture rate', speciesTable.every((s) => s.catchRate >= 1 && s.catchRate <= 255));
check('4. every species carries a growth rate and base exp', speciesTable.every((s) => s.growthRate && s.baseExp > 0));

// --- the type chart: thirty landmarks --------------------------------------
const CHART_LANDMARKS = [
  ['water', ['fire'], 2], ['fire', ['water'], 0.5], ['electric', ['ground'], 0],
  ['ground', ['flying'], 0], ['normal', ['ghost'], 0], ['ghost', ['normal'], 0],
  ['fighting', ['ghost'], 0], ['poison', ['steel'], 0], ['psychic', ['dark'], 0],
  ['dragon', ['fairy'], 0], ['ice', ['dragon', 'flying'], 4], ['rock', ['fire', 'flying'], 4],
  ['grass', ['water', 'ground'], 4], ['fighting', ['normal'], 2], ['fairy', ['dragon'], 2],
  ['fairy', ['dark'], 2], ['steel', ['fairy'], 2], ['poison', ['fairy'], 2],
  ['bug', ['psychic'], 2], ['dark', ['ghost'], 2], ['flying', ['fighting'], 2],
  ['ground', ['electric'], 2], ['ice', ['grass'], 2], ['steel', ['ice'], 2],
  ['normal', ['rock', 'steel'], 0.25], ['electric', ['grass', 'dragon'], 0.25],
  ['grass', ['fire'], 0.5], ['psychic', ['steel'], 0.5], ['fire', ['dragon'], 0.5],
  ['water', ['water'], 0.5],
];
let chartOk = 0;
for (const [atk, def, want] of CHART_LANDMARKS) {
  if (effectiveness(atk, def) === want) chartOk++;
  else check(`   chart ${atk} -> ${def.join('/')}`, false, `got ${effectiveness(atk, def)}, want ${want}`);
}
eq('5. type chart landmarks (30)', chartOk, CHART_LANDMARKS.length);
eq('6. the chart has eighteen types', TYPES.length, 18);
check('7. an unknown type is neutral, not zero', effectiveness('__nope', ['fire']) === 1);
// Found by looking at the showcase, not by a test: a bare string used to be iterated as
// characters, so every lookup missed and every pair came back a confident 1.
eq('7b. a bare defender string is coerced, not iterated', effectiveness('water', 'fire'), 2);

// --- stats and curves -------------------------------------------------------
const gStats = statsOf({ hp: 108, atk: 130, def: 95, spa: 80, spd: 85, spe: 102 },
  { hp: 24, atk: 12, def: 30, spa: 16, spd: 23, spe: 5 }, 78);
eq('8. Garchomp Lv78 HP (no EVs)', gStats.hp, 275);
eq('9. Garchomp Lv78 Atk (no EVs)', gStats.atk, 217);
eq('10. medium curve tops out at 1,000,000', expAtLevel('medium', 100), 1000000);
eq('11. medium-slow tops out at 1,059,860', expAtLevel('medium-slow', 100), 1059860);
eq('12. erratic tops out at 600,000', expAtLevel('erratic', 100), 600000);
eq('13. fluctuating tops out at 1,640,000', expAtLevel('fluctuating', 100), 1640000);
eq('14. slow tops out at 1,250,000', expAtLevel('slow', 100), 1250000);
eq('15. fast tops out at 800,000', expAtLevel('fast', 100), 800000);
check('16. every curve is monotone from 1 to 100', ['fast', 'medium', 'medium-slow', 'slow', 'erratic', 'fluctuating']
  .every((g) => { for (let n = 2; n <= 100; n++) if (expAtLevel(g, n) <= expAtLevel(g, n - 1)) return false; return true; }));
eq('17. levelForExp inverts expAtLevel', levelForExp('medium', 8000), 20);
eq('18. stat stage +2 doubles, -2 halves', `${stageMultiplier(2)}/${stageMultiplier(-2)}`, '2/0.5');
eq('19. expYield scales on the loser, not the winner', expYield(64, 5), 45);

// --- the streams ------------------------------------------------------------
// `ctx.rng` is makeRng(seed,'root') and fork APPENDS, so this identity is what makes the
// browser and this file roll the same battle. Asserted on three consecutive draws rather
// than trusted from the comment — the same check `encounter/selftest.js` opens with.
const forked = makeRng(1337, 'root').fork('battle').fork('7').fork('1');
const direct = streamFor(1337, 7, 1);
eq('20. stream label identity', direct.label, `${STREAM_ROOT}/7/1`);
check('21. fork(battle) and streamFor agree on three draws',
  [0, 1, 2].every(() => forked.next() === direct.next()));

// --- the golden fight -------------------------------------------------------
// Oshawott (the starter `simulation` seeds) against a Caterpie, both at fixed IVs so the only
// variable is the engine. If ANY of these five move, a draw was inserted, removed or reordered.
const IVS = { hp: 20, atk: 20, def: 20, spa: 20, spd: 20, spe: 20 };
const osha = makeCombatant({ species: by.oshawott, level: 12, ivs: IVS });
const cat = makeCombatant({ species: by.caterpie, level: 8, ivs: IVS });

eq('22. derived moves are the last four learnable', osha.moves.map((m) => m.id).join(','),
  'tackle,tailwhip,watergun,soak');
eq('23. a move slot starts at its full PP', osha.moves.find((m) => m.id === 'watergun').pp, 25);

const fight = resolve(osha, cat, 1337, 12);
eq('24. golden fight: winner', fight.winner, 'a');
eq('25. golden fight: turns', fight.turns, 2);
eq('26. golden fight: winner HP left', fight.a.hp, 34);
eq('27. golden fight: hpFraction of the beaten wild', fight.hpFraction, 0);
eq('28. golden fight: transcript length', fight.transcript.length, 7);
eq('29. golden fight: the first move chosen is STAB Water Gun, not Tackle',
  fight.transcript[0].move, 'watergun');

eq('30. golden damage: Tackle', damageOf(osha, cat, MOVES.resolveMove('tackle'), { band: 1 }).damage, 10);
eq('31. golden damage: Water Gun (STAB)', damageOf(osha, cat, MOVES.resolveMove('watergun'), { band: 1 }).damage, 19);

// --- invariants over a sweep ------------------------------------------------
const names = Object.keys(by).filter((n) => MOVES.learnset(n).length);
let worstTurns = 0, stalls = 0, negPp = 0, nonRepro = 0, immortal = 0;
for (let i = 0; i < 300; i++) {
  const A = makeCombatant({ species: by[names[i % names.length]], level: 25, ivs: IVS });
  const B = makeCombatant({ species: by[names[(i * 7 + 3) % names.length]], level: 22, ivs: IVS });
  const r1 = resolve(A, B, 1337, i);
  const r2 = resolve(A, B, 1337, i);
  if (JSON.stringify(r1.transcript) !== JSON.stringify(r2.transcript)) nonRepro++;
  worstTurns = Math.max(worstTurns, r1.turns);
  if (r1.stalled) stalls++;
  if (r1.a.hp > 0 && r1.b.hp > 0) immortal++;
  for (const s of [...r1.a.moves, ...r1.b.moves]) if (s.pp < 0) negPp++;
}
eq('32. sweep: every fight is reproducible', nonRepro, 0);
eq('33. sweep: PP never goes negative', negPp, 0);
eq('34. sweep: no fight stalls out (Struggle ends them)', stalls, 0);
eq('35. sweep: every fight has a loser', immortal, 0);
check('36. sweep: no fight runs long', worstTurns <= 40, `worst was ${worstTurns} turns`);

// --- the stepper is the implementation, and `resolve` is a drain of it -------
//
// Every check below is the evidence DECISIONS #72 rests on: the seam that lets a fight be
// watched turn by turn did not disturb the index space. If 24-29 above ever move at the same
// time as one of these, the between-hook has leaked a draw and the whole replay is wrong.
{
  const run = stepper(osha, cat, 1337, 12);
  const stepped = [];
  let turns = 0;
  while (!run.over) { stepped.push(...run.step().events); turns++; }
  eq('37. stepping the golden fight equals draining it',
    JSON.stringify(stepped), JSON.stringify(fight.transcript));
  eq('38. the stepper reports the same turn count', turns, 2);
  eq('39. one Pokemon was ever sent out', fight.sent, 1);
  eq('40. an untouched fight never hits the between cap', fight.betweenCapped, false);
}

// A `between` that does nothing must be indistinguishable from no `between` at all, or the
// hook itself is a behaviour change rather than a seam.
eq('41. a between that returns nothing changes nothing',
  JSON.stringify(resolve(osha, cat, 1337, 12, { between: () => [] }).transcript),
  JSON.stringify(fight.transcript));

// --- what a strike is -------------------------------------------------------
{
  const strikes = strikesOf(fight.transcript, { a: 'Oshawott', b: 'Caterpie' });
  eq('42. the golden fight is three strikes', strikes.length, 3);
  eq('43. strike 1: Oshawott lands Water Gun on Caterpie',
    JSON.stringify({
      turn: strikes[0].turn, attacker: strikes[0].attacker, target: strikes[0].target,
      move: strikes[0].move, damage: strikes[0].damage, hits: strikes[0].hits,
      effectiveness: strikes[0].effectiveness, crit: strikes[0].crit, miss: strikes[0].miss,
      fainted: strikes[0].fainted,
    }),
    JSON.stringify({
      turn: 1, attacker: 'a', target: 'b', move: 'watergun', damage: 16, hits: 1,
      effectiveness: 1, crit: false, miss: false, fainted: null,
    }));
  eq('44. strike 2 is the wild answering', strikes[1].attacker, 'b');
  eq('45. the last strike is the one that faints it', strikes[2].fainted, 'b');
  eq('46. a strike reads as a sentence', describeStrike(strikes[0]), 'Oshawott used Water Gun');
  // A mirror match is why `faint` carries `actor`: `species` alone cannot say who fell.
  const mirror = resolve(
    makeCombatant({ species: by.caterpie, level: 12, ivs: IVS }),
    makeCombatant({ species: by.caterpie, level: 8, ivs: IVS }), 1337, 5);
  const fell = mirror.transcript.find((e) => e.kind === 'faint');
  eq('47. a mirror match still names the side that fell', fell.actor, mirror.winner === 'a' ? 'b' : 'a');
}

// --- items between two turns ------------------------------------------------
{
  const hurt = makeCombatant({ species: by.oshawott, level: 12, ivs: IVS, hp: 5 });
  const ev = applyAction({ turn: 1, a: hurt, b: null }, { kind: 'heal', item: 'potion', hp: 20 });
  eq('48. a potion heals by its own number', hurt.hp, 25);
  eq('49. and says so on the transcript', `${ev.kind}/${ev.use}/${ev.healed}`, 'item/heal/20');

  // The rule the mainline is emphatic about, and which `pokemon/instance.js heal()` would have
  // broken: a Potion is not a Revive. Without this an auto-heal list resurrects for 200 gold.
  const down = makeCombatant({ species: by.oshawott, level: 12, ivs: IVS, hp: 0 });
  applyAction({ turn: 1, a: down, b: null }, { kind: 'heal', item: 'maxpotion', hp: 'full' });
  eq('50. a heal never raises a fainted Pokemon', down.hp, 0);
  applyAction({ turn: 1, a: down, b: null }, { kind: 'revive', item: 'revive', fraction: 0.5 });
  eq('51. a revive does, at half of maximum', down.hp, Math.round(down.maxHp * 0.5));
  const up = makeCombatant({ species: by.oshawott, level: 12, ivs: IVS, hp: 7 });
  applyAction({ turn: 1, a: up, b: null }, { kind: 'revive', item: 'maxrevive', fraction: 1 });
  eq('52. and a revive is refused on a conscious one', up.hp, 7);

  const spent = makeCombatant({ species: by.oshawott, level: 12, ivs: IVS });
  spent.moves[2].pp = 0;
  applyAction({ turn: 1, a: spent, b: null }, { kind: 'pp', item: 'ether', moveId: 'watergun', amount: 10 });
  eq('53. an ether restores PP to the slot it names', spent.moves[2].pp, 10);
}

// --- an ally faint is not the end of the fight ------------------------------
{
  // A level-3 Magikarp against a level-30 Gyarados loses, and loses again, and then the third
  // member wins nothing either — the point is that the duel CONTINUES, which is what makes
  // "if no usable Pokemon remain, the player loses the hunt" a rule rather than a phrase.
  const bench = [
    makeCombatant({ species: by.oshawott, level: 5, ivs: IVS }),
    makeCombatant({ species: by.snivy, level: 5, ivs: IVS }),
  ];
  let sent = 0;
  const lost = resolve(
    makeCombatant({ species: by.magikarp, level: 3, ivs: IVS }),
    makeCombatant({ species: by.gyarados, level: 40, ivs: IVS }),
    1337, 21, { nextAlly: () => bench[sent++] ?? null });
  eq('54. a party keeps fighting until it runs out', lost.sent, 3);
  eq('55. and only then is the fight lost', lost.winner, 'b');
  check('56. each swap is on the transcript',
    lost.transcript.filter((e) => e.kind === 'swap').length === 2,
    `${lost.transcript.filter((e) => e.kind === 'swap').length} swaps`);

  // A revive gets first refusal, so the same Pokemon comes back up rather than being replaced.
  let revives = 1;
  const saved = resolve(
    makeCombatant({ species: by.magikarp, level: 3, ivs: IVS }),
    makeCombatant({ species: by.gyarados, level: 40, ivs: IVS }),
    1337, 21, {
      between: (st) => (st.a.hp <= 0 && revives-- > 0
        ? [{ kind: 'revive', item: 'maxrevive', fraction: 1 }] : []),
      nextAlly: () => null,
    });
  eq('57. a revive is taken before a swap', saved.sent, 1);
  check('58. and the fight went on', saved.turns > lost.turns - lost.sent, `${saved.turns} turns`);
}

eq('59. the between cap is four', MAX_BETWEEN, 4);
check('60. a runaway between is capped rather than obeyed',
  resolve(osha, cat, 1337, 12, {
    between: () => Array.from({ length: 9 }, () => ({ kind: 'heal', item: 'potion', hp: 1 })),
  }).betweenCapped === true);

// --- 61-64 TYPE_INK: the one colour table a balloon, a floater and a strike's own effect ----
// all read (DECISIONS #87). `core`/`edge` are strikes.js's own values, unchanged; `ink` is
// derived from `edge` and has to actually clear the contrast floor it was derived to hit, not
// merely look plausible.
{
  eq('61. eighteen types, eighteen colour triples', Object.keys(TYPE_INK).length, 18);
  check('62. every triple is three real hex colours',
    Object.values(TYPE_INK).every((t) => ['core', 'edge', 'ink'].every((k) => /^#[0-9a-f]{6}$/i.test(t[k]))));
  // Simple weighted luminance — an ordering check, not a ratio, so the cheap formula this
  // file's sibling checks (49-52) don't need is not needed here either.
  const lum = (h) => {
    const n = parseInt(h.slice(1), 16);
    return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
  };
  check('63. every core is brighter than its own edge',
    Object.entries(TYPE_INK).every(([, t]) => lum(t.core) > lum(t.edge)),
    Object.entries(TYPE_INK).filter(([, t]) => lum(t.core) <= lum(t.edge)).map(([k]) => k).join(' '));

  // The WCAG contrast ratio `ink` was actually derived against — the paper a balloon and a
  // floater print on (`ui/theme.js`'s `C.wallLight`, '#F5E9CE'). A future palette edit that
  // moves `ink` without re-deriving it fails here, loudly, instead of shipping an unreadable
  // move name for one type that nobody happened to screenshot.
  const srgbToLin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const relLum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const r = srgbToLin((n >> 16) & 255), g = srgbToLin((n >> 8) & 255), b = srgbToLin(n & 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const PAPER = '#F5E9CE';
  const ratios = Object.entries(TYPE_INK).map(([k, t]) => [k, contrast(t.ink, PAPER)]);
  check('64. every type\'s ink clears 4.5:1 against the balloon paper',
    ratios.every(([, r]) => r >= 4.5), ratios.map(([k, r]) => `${k}:${r.toFixed(2)}`).join(' '));

  eq('65. an unknown type still gets a colour', typeColour('nonsense'), TYPE_INK.normal);
  check('66. every one of the eighteen types resolves to its own triple',
    Object.keys(TYPE_INK).every((t) => typeColour(t) === TYPE_INK[t]));
}

// --- report -----------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
console.log(`\nbattle: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
