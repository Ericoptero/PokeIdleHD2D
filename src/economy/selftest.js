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
 *
 * `trainer.js` joined them in DECISIONS #70. Its curve is closed-form in both directions — the
 * triangular numbers and their inverse — so the check that matters is that the two agree at
 * every level, and that the four biome gates the maps ship with land where they were authored
 * to. A gate off by one is invisible in a screenshot and locks a player out of a map.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { speciesPrice, throwsToPity, BASE_PRICE } from './pricing.js';
import { makePity, PITY_START, PITY_FULL, BP_MONEY_EQUIVALENT } from './pity.js';
import { trainerFromWins, levelFromWins, winsForLevel, STEP } from './trainer.js';
import { item, ITEMS } from './items.js';

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

// --- the trainer curve ------------------------------------------------------
{
  // Closed form in both directions, so the only thing worth asserting is that they invert.
  let ok = true;
  let firstBad = '';
  // From 2: level 1 is 0 wins and there is no "one win before level 1" to check the boundary
  // against. `levelFromWins(0) === 1` is check 20.
  for (let n = 2; n <= 200; n++) {
    const wins = winsForLevel(n);
    if (levelFromWins(wins) !== n || levelFromWins(wins - 1) !== n - 1 || levelFromWins(wins + 1) !== n) {
      ok = false; firstBad = `level ${n} at ${wins} wins`; break;
    }
  }
  check('18. the level and its wins invert exactly, either side of the boundary', ok, firstBad);

  // Monotone, and every win counts for something: `into`/`need` is what the HUD bar draws.
  let monotone = true;
  let prev = 0;
  for (let w = 0; w <= 2000; w++) {
    const t = trainerFromWins(w);
    if (t.level < prev || t.into < 0 || t.into >= t.need) { monotone = false; break; }
    prev = t.level;
  }
  check('19. the level never falls and the progress bar never overflows', monotone);

  // **The four gates the biomes actually ship.** These are the numbers a locked travel row
  // prints, and they were chosen against this curve; if the curve moves, the maps move with it
  // and nobody notices until a save is a hundred battles further along than the map expects.
  eq('20. a fresh save is trainer level 1', trainerFromWins(0).level, 1);
  eq('21. the forest gate (Lv5) is 30 wins', winsForLevel(5), 30);
  eq('22. the coast gate (Lv12) is 198 wins', winsForLevel(12), 198);
  eq('23. the cave gate (Lv20) is 570 wins', winsForLevel(20), 570);
  eq('24. the step between levels is the triangular one', winsForLevel(3) - winsForLevel(2), STEP * 2);
}


// --- PP restoration, which the game modelled and could not buy ---------------
//
// Per-move PP and Struggle have been in the engine since the turn engine landed, and until
// DECISIONS #72 there was no item anywhere in the tree that put PP back — so a long hunt ended
// in a Pokemon flailing at 50 power with recoil and no purchasable answer. Auto-Ether is what
// the brief asks for; these two are what it spends.
{
  const ether = item('ether');
  const maxether = item('maxether');
  check('25. an Ether exists at all', !!ether && !!maxether);
  eq('26. an Ether restores a fixed 10 PP', ether.heal.pp, 10);
  eq('27. a Max Ether restores the slot', maxether.heal.pp, 'full');
  // The no-arbitrage invariant every money-priced item is held to: you may never buy a thing
  // and sell it back for more than 90% of what you paid.
  check('28. neither ether can be bought and resold at a profit',
    ether.sell <= Math.floor(ether.price * 0.9) && maxether.sell <= Math.floor(maxether.price * 0.9),
    `${ether.sell}/${Math.floor(ether.price * 0.9)}, ${maxether.sell}/${Math.floor(maxether.price * 0.9)}`);
  // A PP item is medicine, so the Bag view picks it up and the Stash view does not.
  eq('29. an ether is medicine, so it lands in the Bag and not the Stash', ether.category, 'medicine');
  // Every heal payload the appliers know how to read. A typo in a new item would otherwise be a
  // silent no-op at the moment a player needed it.
  const KNOWN = new Set(['hp', 'status', 'revive', 'pp', 'fraction']);
  const strange = ITEMS.filter((d) => d.heal && Object.keys(d.heal).some((k) => !KNOWN.has(k)));
  eq('30. every medicine payload is one the appliers understand', strange.length, 0);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
console.log(`\neconomy: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
