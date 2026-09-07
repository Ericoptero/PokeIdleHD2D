#!/usr/bin/env node
/**
 * Builds the blind A/B packets for the final gate (brief step 5).
 *
 * A judge must not be able to tell which image is ours from anything but the picture, so:
 *
 *  - our shot is captured at the *reference's own* pixel dimensions, never resampled. A
 *    1920x1080 render sat next to a 794x446 still is a giveaway before anyone looks at it;
 *  - the two files are written as `A.png` / `B.png` inside `docs/judge/<round>/<id>/`, and
 *    which is which comes from a seeded hash of `round:id` — reproducible, but not
 *    guessable from the packet, and different every round;
 *  - the answer key is written *outside* the packet folders, in `docs/judge/<round>/key.json`,
 *    so a judge agent pointed at a packet folder cannot read it.
 *
 * Then hand each packet folder to a judge agent, collect its verdict as
 * `docs/judge/<round>/<id>/verdict.json`, and run `tools/judge/score.js`.
 *
 *   node tools/judge/build.js --round r1                    # every pair in the plan
 *   node tools/judge/build.js --round r1 --only forest-day
 */

import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shoot } from '../shots/shoot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const REFS = join(REPO, 'docs', 'refs');

/** Reads width/height straight out of the PNG IHDR — no image library needed. */
export function pngSize(path) {
  const head = readFileSync(path).subarray(0, 33);
  if (head.readUInt32BE(12) !== 0x49484452) throw new Error(`${path} is not a PNG`);
  return [head.readUInt32BE(16), head.readUInt32BE(20)];
}

/** FNV-1a, so the A/B order is deterministic per round but carries no pattern. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function parse(argv) {
  const a = { round: 'r1', only: null, plan: join(HERE, 'plan.json'), base: 'http://127.0.0.1:5173', settle: 40 };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1]?.startsWith('--') === false ? argv[++i] : true;
    a[k] = v;
  }
  return a;
}

export async function build(a) {
  const plan = JSON.parse(readFileSync(a.plan, 'utf8'));
  const pairs = plan.pairs.filter((p) => !a.only || p.id === a.only);
  const outRoot = join(REPO, 'docs', 'judge', a.round);
  const key = { round: a.round, builtFrom: a.plan, pairs: [] };
  const failures = [];

  for (const p of pairs) {
    const refPath = join(REFS, p.ref);
    if (!existsSync(refPath)) { failures.push(`${p.id}: reference ${p.ref} missing`); continue; }
    const [w, h] = pngSize(refPath);
    const dir = join(outRoot, p.id);
    mkdirSync(dir, { recursive: true });

    // Capture ours at the reference's exact size. pixelScale is left to the app's default so
    // the internal buffer scales with the window and the pixel grid stays honest.
    // It lands *outside* the packet: a file called `_ours.png` sitting next to A and B would
    // hand the answer to any judge who listed the directory.
    const capDir = join(outRoot, '.captures');
    mkdirSync(capDir, { recursive: true });
    const mine = join(capDir, `${p.id}.png`);
    const log = await shoot({
      base: a.base, out: mine, size: `${w}x${h}`, settle: Number(a.settle),
      showcase: p.shot.showcase ?? null, mode: p.shot.mode ?? null,
      preset: p.shot.preset ?? null, tod: p.shot.tod ?? null,
      seed: p.shot.seed ?? 1, timeout: 45000, retries: 3, extra: p.shot.extra ?? {},
    });
    if (!log.ok) {
      failures.push(`${p.id}: capture failed — ${log.error ?? log.fatal ?? 'no error reported'}`);
      continue;
    }

    const oursIsA = (hash(`${a.round}:${p.id}`) & 1) === 0;
    copyFileSync(mine, join(dir, oursIsA ? 'A.png' : 'B.png'));
    copyFileSync(refPath, join(dir, oursIsA ? 'B.png' : 'A.png'));

    writeFileSync(join(dir, 'PROMPT.md'), packetPrompt(p, [w, h]));
    key.pairs.push({
      id: p.id, ours: oursIsA ? 'A' : 'B', ref: p.ref, size: [w, h],
      refIsNearest: !!p.refIsNearest, shot: p.shot,
      fps: log.fps?.mean ?? null, drawCalls: log.drawCalls ?? null,
      consoleErrors: (log.consoleErrors ?? []).length,
    });
  }

  mkdirSync(outRoot, { recursive: true });
  writeFileSync(join(outRoot, 'key.json'), JSON.stringify({ ...key, failures }, null, 2));
  return { key, failures, outRoot };
}

function packetPrompt(p, size) {
  return `# Blind comparison — packet \`${p.id}\`

Two screenshots, \`A.png\` and \`B.png\`, both ${size[0]}x${size[1]}. One is from a shipped
commercial Pokemon-style game, the other from a game in development. **You are not told which
is which, and you must not guess based on anything but how the images look.**

${p.question}

Look at both images. Then answer, as JSON written to \`verdict.json\` in this folder:

\`\`\`json
{
  "better": "A" | "B",
  "confidence": 0.0-1.0,
  "why": "two or three sentences on what actually decided it",
  "weaknesses": { "A": ["..."], "B": ["..."] },
  "tell": "if one image looks unfinished or engine-like rather than art-directed, say which and why — otherwise null"
}
\`\`\`

Judge on: readability of the scene, lighting and shadow believability, colour and contrast,
material and texture quality, composition and depth, and whether the image looks like a
finished game or like a test scene. Do not reward an image for being sharper or larger —
they are the same size. Be blunt; an honest loss is worth more than a polite tie.
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parse(process.argv.slice(2));
  const { key, failures, outRoot } = await build(a);
  for (const pair of key.pairs) {
    console.log(`✓ ${pair.id.padEnd(14)} ours=${pair.ours}  ${pair.size.join('x')}  ` +
      `${pair.fps ?? '?'}fps ${pair.drawCalls ?? '?'}dc${pair.refIsNearest ? '  (nearest ref, not a like-for-like)' : ''}`);
  }
  for (const f of failures) console.log(`✗ ${f}`);
  console.log(`\n${key.pairs.length} packet(s) at ${outRoot}; key.json holds the answers.`);
  if (failures.length) process.exitCode = 1;
}
