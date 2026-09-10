#!/usr/bin/env node
/**
 * The boot matrix: every way into the game, booted once, asserted to draw something.
 *
 *   node tools/shots/boot.js
 *   node tools/shots/boot.js --only scene        # or: showcase
 *   node tools/shots/boot.js --keep              # keep the PNGs instead of overwriting one
 *
 * **Why this exists.** Every entry point into this game can fail the same silent way: the
 * page loads, `__READY__` goes true, no error is logged, and the frame is an empty blue void
 * at nine draw calls. `shoot.js` would call that a pass — it budgets a *ceiling* on draw
 * calls and never a floor. Three such bugs shipped in one commit (DECISIONS #70):
 * `?scene=hunt-cave` booted into nothing because the trainer-level gate did not stand down
 * for it, and a save naming a now-locked scene did the same but would have reached a player.
 * All three were found by re-reading the code. None of them was found by a test, because
 * nothing had ever booted the other entry points.
 *
 * **The matrix is derived, never listed.** Showcase ids come from the registry and scene ids
 * from `__HOOKS__.destinations()`, so a biome added tomorrow is covered tomorrow — the same
 * reason `tools/seams/run.js` discovers `selftest.js` by existence.
 *
 * **Locked scenes are booted on purpose.** `?scene=` stands the gate down by design, so the
 * gated biomes are exactly the ones whose boot path is least travelled and most likely to
 * rot. Skipping them would skip the bug this file was written for.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { shoot, checkBudgets, parseArgs } from './shoot.js';

/**
 * A frame with fewer draws than this is not a scene. An empty void measured 9; the thinnest
 * real thing in the game (a `preview` checkerboard, a `battle` card over a flat backdrop)
 * measures comfortably above 20.
 */
const MIN_DRAW_CALLS = 20;

/**
 * Showcases that prove themselves with **evidence rather than with a frame**: they print real
 * transcripts and real ledgers into the DOM and stage no 3-D scene at all, so a draw-call
 * floor is the wrong instrument — a broken one draws exactly as much empty stage as a working
 * one. They are held to a text floor instead, which is a *tighter* check for what they do.
 */
const DOM_SHOWCASE = { battle: 400 };

const a = parseArgs(process.argv.slice(2));
const OUT = a.out ?? 'shots/out/boot';
const only = a.only ?? null;
mkdirSync(OUT, { recursive: true });

/**
 * Ask a live page what the tree contains. One browser boot to enumerate, then one per case.
 * `?showcase=travel` is used for the probe because `travel` is what owns the destination
 * table and it pulls in `city` and `hunts` to build it.
 */
async function discover() {
  const probe = await shoot({ ...a, showcase: 'travel', out: join(OUT, '_probe.png'), tod: 12 });
  if (probe.error || probe.fatal) {
    console.error(`✗ boot: the discovery probe itself failed — ${probe.error ?? probe.fatal}`);
    process.exit(1);
  }
  const showcases = (probe.modules ?? []).map((m) => m.id).filter(Boolean).sort();
  const scenes = (probe.destinations ?? []).map((d) => d.id);
  return { showcases, scenes };
}

const { showcases, scenes } = await discover();
if (!scenes.length) {
  console.error('✗ boot: __HOOKS__.destinations() returned nothing — the matrix cannot be derived');
  process.exit(1);
}

const cases = [];
if (only !== 'scene') for (const id of showcases) cases.push({ kind: 'showcase', id });
if (only !== 'showcase') for (const id of scenes) cases.push({ kind: 'scene', id });

console.log(`boot matrix: ${cases.length} cases (${showcases.length} showcases, ${scenes.length} scenes)\n`);

const rows = [];
for (const c of cases) {
  const out = join(OUT, `${c.kind}-${c.id}.png`);
  const extra = c.kind === 'scene' ? { scene: c.id } : {};
  const log = await shoot({ ...a, showcase: c.kind === 'showcase' ? c.id : undefined, extra, out, tod: 12 });

  const fails = checkBudgets(log);
  // The floor. This is the whole point of the file: a ceiling cannot see an empty frame.
  const textFloor = c.kind === 'showcase' ? DOM_SHOWCASE[c.id] : undefined;
  if (textFloor !== undefined) {
    if ((log.uiChars ?? 0) < textFloor) {
      fails.push(`showed nothing: ${log.uiChars ?? 0} chars of UI text < ${textFloor} — an empty panel`);
    }
  } else if ((log.drawCalls ?? 0) < MIN_DRAW_CALLS) {
    fails.push(`drew nothing: ${log.drawCalls ?? 0} draw calls < ${MIN_DRAW_CALLS} — an empty scene, not a scene`);
  }
  rows.push({ ...c, fails, drawCalls: log.drawCalls ?? 0, uiChars: log.uiChars ?? 0, fps: log.fps?.mean ?? 0, ms: log.ms });

  const badge = fails.length ? '✗' : '✓';
  const measure = textFloor !== undefined
    ? `${String(log.uiChars ?? '?').padStart(5)} chars`
    : `${String(log.drawCalls ?? '?').padStart(5)} draws`;
  console.log(`${badge} ${c.kind.padEnd(8)} ${c.id.padEnd(16)} ${measure}  ` +
    `${String(log.fps?.mean ?? '?').padStart(5)} fps  ${log.ms}ms`);
  for (const f of fails) console.log(`    ! ${f}`);
}

if (!a.keep) { try { rmSync(join(OUT, '_probe.png'), { force: true }) } catch { /* nothing to clean */ } }

const failed = rows.filter((r) => r.fails.length);
console.log(`\nboot: ${rows.length - failed.length}/${rows.length} entry points draw a real frame`);
for (const r of failed) console.log(`  ✗ ${r.kind} ${r.id}: ${r.fails.join('; ')}`);
process.exit(failed.length ? 1 : 0);
