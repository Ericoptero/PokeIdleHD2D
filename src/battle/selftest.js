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
import { effectiveness, TYPES } from './types.js';
import { statsOf, expAtLevel, levelForExp, expYield, stageMultiplier } from './stats.js';
import { makeCombatant, resolve, damageOf, streamFor, STREAM_ROOT } from './engine.js';
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

// --- report -----------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
console.log(`\nbattle: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
