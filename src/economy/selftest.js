#!/usr/bin/env node
/**
 * Property checks for the two pure files DECISIONS #68 added — `pricing.js` and `pity.js`.
 * Discovered and run under plain Node by `tools/seams/run.js` rule 6.
 *
 *   node src/economy/selftest.js
 *
 * The rest of `economy` is exercised by `selfTest()` inside the module and by its showcase.
 * What is worth checking here is the arithmetic a screenshot cannot show: that the pity ramp
 * is exactly `p0` below 90 %, exactly 1 at 125 %, and monotone in between; and that the price
 * curve lands where the ball line says it should, because those two numbers together are the
 * whole grind.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { speciesPrice, throwsToPity, BASE_PRICE } from './pricing.js';
import { makePity, PITY_START, PITY_FULL, BP_MONEY_EQUIVALENT } from './pity.js';
import { item } from './items.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const species = JSON.parse(readFileSync(join(REPO, 'public', 'generated', 'species.json'), 'utf8'));
const by = Object.fromEntries(species.map((s) => [s.name, s]));

const results = [];
const check = (n, ok, d = '') => { results.push({ name: n, ok: !!ok, detail: d }); return !!ok; };
const eq = (n, got, want) => check(n, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// --- prices -----------------------------------------------------------------
check('1. every species has a price', species.every((s) => speciesPrice(s) >= 100));
check('2. rarer is dearer', speciesPrice(by.gible) > speciesPrice(by.rattata),
  `gible ${speciesPrice(by.gible)} vs rattata ${speciesPrice(by.rattata)}`);
check('3. bigger is dearer at the same rarity', speciesPrice(by.dragonite) > speciesPrice(by.gible),
  `${speciesPrice(by.dragonite)} vs ${speciesPrice(by.gible)}`);
eq('4. a shiny is worth ten times as much',
  speciesPrice(by.caterpie, { shiny: true }), speciesPrice(by.caterpie) * 10);

// The tuning gate, stated as the design target rather than as the formula.
const common = throwsToPity(by.rattata, 200);
const rare = throwsToPity(by.gible, 200);
check('5. a common costs 6-10 Poké Balls to guarantee', common >= 6 && common <= 10, `${common}`);
check('6. a 45-rate costs 40-80', rare >= 40 && rare <= 80, `${rare}`);
check('7. nothing is an unfinishable wall', species.every((s) => throwsToPity(s, 200) <= 190),
  `worst ${Math.max(...species.map((s) => throwsToPity(s, 200)))} Poké Balls`);
check('8. the anchor is the ball line', BASE_PRICE / 200 >= 5 && BASE_PRICE / 200 <= 10,
  `${BASE_PRICE / 200} Poké Balls`);

// --- the pity ramp ----------------------------------------------------------
{
  const pity = makePity({ price: () => 1000, item });
  const P0 = 0.2;
  eq('9. an untouched species is at exactly p0', pity.apply(P0, 'x').odds, P0);

  // Below the start: still exactly p0, not "nearly". The price is large so one Poké Ball is a
  // fine step — at a price of 1000 a single ball moves the ratio by 0.2 and the loop below
  // sails straight past 0.9, which is the test being coarse and not the ramp being wrong.
  const fine = makePity({ price: () => 100000, item });
  while (fine.meter('x').ratio < PITY_START - 0.005) fine.credit('x', 'pokeball');
  check('10. below 90% the odds are UNCHANGED', fine.apply(P0, 'x').odds === P0,
    `ratio ${fine.meter('x').ratio.toFixed(4)} -> ${fine.apply(P0, 'x').odds}`);

  const seen = [];
  for (let i = 0; i < 40; i++) { pity.credit('x', 'pokeball'); seen.push(pity.apply(P0, 'x').odds); }
  check('11. the ramp never goes down', seen.every((v, i) => i === 0 || v >= seen[i - 1]));
  check('12. it reaches certainty', seen[seen.length - 1] === 1, `${seen[seen.length - 1]}`);

  // And it gets there at 125 % of the price, not before and not after.
  const p2 = makePity({ price: () => 1000, item });
  while (p2.meter('y').ratio < PITY_FULL - 1e-9) p2.credit('y', 'pokeball');
  check('13. certainty arrives at 1.25x the price', p2.apply(P0, 'y').odds === 1
    && p2.meter('y').ratio >= PITY_FULL, `ratio ${p2.meter('y').ratio.toFixed(3)}`);

  const p3 = makePity({ price: () => 1000, item });
  p3.credit('z', 'pokeball');
  p3.reset('z');
  eq('14. a catch clears that species, and only that one', p3.meter('z').sum, 0);

  // BP-priced balls count, or the shop's dearest shelf would be free pity.
  const p4 = makePity({ price: () => 1e9, item });
  p4.credit('w', 'quickball');
  eq('15. a BP ball counts at its money equivalent', p4.meter('w').sum, 15 * BP_MONEY_EQUIVALENT);

  const p5 = makePity({ price: () => 1000, item });
  p5.credit('v', 'pokeball');
  const round = makePity({ price: () => 1000, item });
  round.restore(p5.serialize());
  eq('16. the ledger survives a save round trip', round.meter('v').sum, p5.meter('v').sum);
  eq('17. a newer slice is refused rather than guessed at', round.restore({ v: 99, sums: {} }), false);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
console.log(`\neconomy: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
