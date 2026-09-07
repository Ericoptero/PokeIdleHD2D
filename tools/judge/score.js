#!/usr/bin/env node
/**
 * Scores a blind round: reads each packet's `verdict.json`, un-blinds it with `key.json`,
 * and prints what actually happened. It deliberately reports losses first and never rounds
 * a result up — the brief's rule is "never inflate scores".
 *
 *   node tools/judge/score.js --round r1
 *   node tools/judge/score.js --round r1 --json      # for docs/STATUS.json
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function score(round) {
  const root = join(REPO, 'docs', 'judge', round);
  const key = JSON.parse(readFileSync(join(root, 'key.json'), 'utf8'));
  const results = [];

  for (const pair of key.pairs) {
    const vPath = join(root, pair.id, 'verdict.json');
    if (!existsSync(vPath)) { results.push({ ...pair, status: 'no verdict' }); continue; }
    let v;
    try { v = JSON.parse(readFileSync(vPath, 'utf8')); }
    catch (err) { results.push({ ...pair, status: `unreadable verdict: ${err.message}` }); continue; }
    const better = String(v.better ?? '').toUpperCase();
    if (better !== 'A' && better !== 'B') { results.push({ ...pair, status: `verdict "${v.better}" is not A or B` }); continue; }
    results.push({
      ...pair, status: 'ok',
      won: better === pair.ours,
      confidence: Number(v.confidence ?? 0),
      why: v.why ?? '', tell: v.tell ?? null,
      weaknessesOfOurs: v.weaknesses?.[pair.ours] ?? [],
    });
  }

  const judged = results.filter((r) => r.status === 'ok');
  const wins = judged.filter((r) => r.won);
  return {
    round,
    packets: results.length,
    judged: judged.length,
    unjudged: results.filter((r) => r.status !== 'ok').map((r) => ({ id: r.id, status: r.status })),
    wins: wins.length,
    losses: judged.length - wins.length,
    // Honest denominator: unjudged packets are *not* silently dropped from the rate.
    winRate: results.length ? Number((wins.length / results.length).toFixed(3)) : 0,
    winRateOfJudged: judged.length ? Number((wins.length / judged.length).toFixed(3)) : 0,
    results,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const round = args[args.indexOf('--round') + 1] ?? 'r1';
  const s = score(round);
  if (args.includes('--json')) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }

  console.log(`Blind round ${s.round}: ${s.wins}/${s.judged} judged pairs went to us ` +
    `(${(s.winRateOfJudged * 100).toFixed(0)}%), ${s.packets} packets built.\n`);
  for (const r of s.results.filter((x) => x.status === 'ok' && !x.won)) {
    console.log(`LOSS  ${r.id}  (ours was ${r.ours}, conf ${r.confidence})`);
    console.log(`      ${r.why}`);
    if (r.tell) console.log(`      tell: ${r.tell}`);
    for (const w of r.weaknessesOfOurs) console.log(`      - ${w}`);
    console.log();
  }
  for (const r of s.results.filter((x) => x.status === 'ok' && x.won)) {
    console.log(`WIN   ${r.id}  (conf ${r.confidence}) ${r.why.split('. ')[0]}.`);
    for (const w of r.weaknessesOfOurs) console.log(`      still weak: ${w}`);
  }
  for (const r of s.unjudged) console.log(`\n?     ${r.id}: ${r.status}`);
  const nearest = s.results.filter((r) => r.refIsNearest).map((r) => r.id);
  if (nearest.length) console.log(`\nNote: ${nearest.join(', ')} had no like-for-like reference; scored against the nearest still.`);
}
