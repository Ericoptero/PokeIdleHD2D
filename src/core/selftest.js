#!/usr/bin/env node
/**
 * Property checks for `src/core/`, run under plain Node by `tools/seams/run.js` rule 6.
 *
 *   node src/core/selftest.js
 *
 * Core is the one folder every module imports, so a break here is a break everywhere — and
 * until this file existed it was the one folder with no checks of its own. `rng`, `clock`,
 * `bus` and `registry` were pinned only indirectly, by whichever module's goldens happened
 * to run through them, which catches a changed *number* and misses a changed *rule*.
 *
 * Three kinds, same as the rest:
 *
 *   1. **Golden values** — literals recorded from seed 1337. Comparing two live calls to
 *      each other cannot catch a reordered stream, because both calls reorder identically
 *      and both agree; only literals can (DECISIONS #35).
 *   2. **Invariants** — the clamps and limits the comments promise: MAX_FRAME_DT, the
 *      throw limit, the spy ring, the topological order.
 *   3. **Isolation** — the properties the whole architecture rests on: sibling streams do
 *      not interfere, a throwing listener does not stop its neighbours, and a failed module
 *      degrades to a null object rather than taking the boot down.
 */

import { makeRng, hashString, noise2 } from './rng.js';
import { makeClock, SIM_DT, SIM_HZ } from './clock.js';
import { makeBus } from './bus.js';
import { makeRegistry } from './registry.js';
import { makeConfig, DEFAULTS } from './config.js';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); return !!ok };
const eq = (name, got, want) => check(name, got === want,
  `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const quietLog = { info() {}, warn() {}, error() {} };

// --- rng --------------------------------------------------------------------
// Golden literals. If these move, every seeded thing in the game moved with them: spawn
// tables, drops, IVs, the shiny roll, scatter. That is a save-breaking change and wants a
// DECISIONS entry, not a re-recorded literal.
{
  const r = makeRng(1337, 'root');
  const seq = [r.next(), r.next(), r.next()].map((n) => Math.round(n * 1e9));
  eq('1. rng: seed 1337 / "root" is the recorded stream', seq.join(','), '594715140,557421650,452650260');
}

{
  const a = makeRng(1337, 'root');
  const b = makeRng(1337, 'root');
  const same = Array.from({ length: 64 }, () => a.next() === b.next()).every(Boolean);
  check('2. rng: same seed and label replay identically', same);
}

{
  const a = makeRng(1337, 'alpha');
  const b = makeRng(1337, 'beta');
  const shared = Array.from({ length: 64 }, () => a.next()).filter((v, i, arr) => arr.indexOf(v) !== i);
  const b0 = makeRng(1337, 'beta').next();
  check('3. rng: a different label is a different stream', makeRng(1337, 'alpha').next() !== b0);
  eq('3b. rng: a stream does not repeat itself in 64 draws', shared.length, 0);
  b.next();
}

// The isolation the event bus and the module boundary both rest on: `encounter` drawing
// twice must not move what `environment` draws next. Fork siblings, interleave one of them
// heavily, and the other must be unmoved.
{
  const root = makeRng(1337, 'root');
  const solo = root.fork('encounter');
  const soloSeq = [solo.next(), solo.next(), solo.next()];

  const root2 = makeRng(1337, 'root');
  const noisy = root2.fork('environment');
  const quiet = root2.fork('encounter');
  for (let i = 0; i < 100; i++) noisy.next();
  const inter = [quiet.next(), quiet.next(), quiet.next()];
  check('4. rng: sibling forks do not interfere', JSON.stringify(soloSeq) === JSON.stringify(inter));
}

{
  const r = makeRng(1337, 'root');
  r.next(); r.next();
  const state = r.save();
  const after = [r.next(), r.next()];
  r.load(state);
  check('5. rng: save/load round-trips the stream', JSON.stringify([r.next(), r.next()]) === JSON.stringify(after));
}

{
  const r = makeRng(99, 'range');
  let bad = 0, ints = 0;
  for (let i = 0; i < 20000; i++) {
    const n = r.next();
    if (!(n >= 0 && n < 1)) bad++;
    const k = r.int(3, 7);
    if (k < 3 || k > 7 || !Number.isInteger(k)) ints++;
  }
  eq('6. rng: next() stays in [0, 1)', bad, 0);
  eq('7. rng: int(min, max) is inclusive at both ends and whole', ints, 0);
}

{
  const r = makeRng(5, 'weighted');
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 10000; i++) counts[r.weighted(['a', 'b'], [3, 1])]++;
  // 3:1 with 10k draws: sampling error is far below this band, so a fail means the walk is
  // wrong, not that the dice were unkind.
  check('8. rng: weighted() honours its weights', counts.a > 7000 && counts.a < 8000,
    `a=${counts.a} b=${counts.b}`);
}

{
  const r = makeRng(1337, 'shuffle');
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = r.shuffle([...arr]);
  eq('9. rng: shuffle() is a permutation, losing nothing', [...out].sort((x, y) => x - y).join(','), arr.join(','));
  const again = makeRng(1337, 'shuffle').shuffle([...arr]);
  eq('10. rng: shuffle() is deterministic', out.join(','), again.join(','));
}

eq('11. rng: hashString is stable', hashString('bw2-adastra'), hashString('bw2-adastra'));
{
  let bad = 0;
  for (let x = -8; x < 8; x++) for (let y = -8; y < 8; y++) {
    const n = noise2(x, y, 3);
    if (!(n >= 0 && n < 1) || n !== noise2(x, y, 3)) bad++;
  }
  eq('12. rng: noise2 is deterministic and in [0, 1)', bad, 0);
}

// --- clock ------------------------------------------------------------------
// The alt-tab clamp. Without it a backgrounded tab returns with a multi-second frame, the
// accumulator swallows it whole, and the world teleports — which is exactly the class of
// thing `idle`/`offline` exist to handle deliberately instead.
{
  const c = makeClock();
  c.beginFrame(0);
  const { frameDt, steps } = c.beginFrame(5000);
  check('13. clock: a 5 s stall is clamped to MAX_FRAME_DT', frameDt <= 0.1 + 1e-9, `frameDt=${frameDt}`);
  check('14. clock: one frame cannot run away with the sim', steps <= 8, `steps=${steps}`);
}

{
  const c = makeClock();
  c.beginFrame(0);
  let steps = 0;
  // 60 frames of 1/60 s is one wall second. The fixed step must neither gain nor lose time:
  // it may hold the last step back (float error leaves the accumulator a hair under SIM_DT),
  // but it may never run ahead, and the shortfall may never exceed one step.
  for (let i = 1; i <= 60; i++) steps += c.beginFrame((i * 1000) / 60).steps;
  check('15. clock: one wall second is SIM_HZ sim steps, to within one pending step',
    steps <= SIM_HZ && steps >= SIM_HZ - 1, `steps=${steps}`);
  check('16. clock: simTime tracks the steps it took', Math.abs(c.simTime - steps * SIM_DT) < 1e-9,
    `simTime=${c.simTime}`);
}

{
  const c = makeClock();
  c.beginFrame(0);
  c.pause();
  const r = c.beginFrame(1000);
  eq('17. clock: a paused clock advances by nothing', `${r.frameDt}/${r.steps}`, '0/0');
  c.resume();
  check('18. clock: resume() does not pay back the paused time', c.beginFrame(1000).frameDt <= 0.1);
}

{
  const c = makeClock();
  c.beginFrame(1000);
  // A backwards `now` (a clock adjustment, a bad caller) must not rewind the world.
  eq('19. clock: time never runs backwards', c.beginFrame(500).frameDt, 0);
}

{
  const c = makeClock();
  const before = c.simTime;
  c.forceSteps(10);
  check('20. clock: forceSteps advances by exactly n steps',
    Math.abs(c.simTime - before - 10 * SIM_DT) < 1e-9, `simTime=${c.simTime}`);
}

// --- bus --------------------------------------------------------------------
{
  const bus = makeBus();
  const seen = [];
  bus.on('x', () => seen.push('a'));
  bus.on('x', () => { throw new Error('boom') });
  bus.on('x', () => seen.push('c'));
  bus.emit('x');
  eq('21. bus: a throwing listener does not stop its neighbours', seen.join(','), 'a,c');
}

{
  const bus = makeBus();
  let calls = 0;
  const errs = [];
  const b2 = makeBus({ onError: (e) => errs.push(String(e.message)) });
  b2.on('x', () => { calls++; throw new Error('boom') });
  for (let i = 0; i < 6; i++) b2.emit('x');
  eq('22. bus: a listener that keeps throwing is removed after 3', calls, 3);
  check('23. bus: the removal is reported, not silent', errs.some((m) => m.includes('removed after 3')));
  bus.clear();
}

{
  const bus = makeBus();
  let n = 0;
  bus.once('x', () => n++);
  bus.emit('x'); bus.emit('x');
  eq('24. bus: once() fires exactly once', n, 1);
}

{
  const bus = makeBus();
  let n = 0;
  const off = bus.on('x', () => n++);
  bus.emit('x');
  off();
  bus.emit('x');
  eq('25. bus: on() returns a working unsubscribe', n, 1);
}

{
  const bus = makeBus();
  let inner = 0;
  bus.on('x', () => { bus.on('x', () => inner++) });
  bus.emit('x');
  eq('26. bus: a listener added during an emit does not fire in that emit', inner, 0);
  bus.emit('x');
  eq('27. bus: …but does fire in the next one', inner, 1);
}

{
  const bus = makeBus();
  for (let i = 0; i < 300; i++) bus.emit('x', i);
  const spy = bus.spy();
  eq('28. bus: the spy ring holds 256', spy.length, 256);
  eq('29. bus: the spy is oldest-first and keeps the newest', `${spy[0].payload}/${spy[255].payload}`, '44/299');
}

{
  const errs = [];
  const bus = makeBus({ onError: (e) => errs.push(String(e.message)) });
  bus.on('x', () => bus.emit('x'));
  bus.emit('x');
  check('30. bus: unbounded recursion is caught, not a stack overflow',
    errs.some((m) => m.includes('recursion depth')));
}

// --- registry ---------------------------------------------------------------
const desc = (id, needs = [], init = () => ({})) => ({ id, needs, init, showcase: () => {} });
const ctxFor = (over = {}) => ({ config: { get: () => '' }, ...over });

{
  const reg = makeRegistry({ bus: makeBus(), log: quietLog });
  const order = [];
  reg.add(desc('c', ['a', 'b'], () => { order.push('c'); return {} }));
  reg.add(desc('b', ['a'], () => { order.push('b'); return {} }));
  reg.add(desc('a', [], () => { order.push('a'); return {} }));
  await reg.init(ctxFor());
  eq('31. registry: init order satisfies every dependency', order.join(','), 'a,b,c');
}

{
  const reg = makeRegistry({ bus: makeBus(), log: quietLog });
  const order = [];
  // Two roots with no relationship: the tie-break is alphabetical, and it is *stable*.
  // `main.js` leans on that when it registers modules whose order would otherwise be an
  // accident of file layout (DECISIONS #61).
  for (const id of ['zeta', 'alpha', 'mu']) reg.add(desc(id, [], () => { order.push(id); return {} }));
  await reg.init(ctxFor());
  eq('32. registry: independent modules tie-break alphabetically', order.join(','), 'alpha,mu,zeta');
}

{
  const reg = makeRegistry({ bus: makeBus(), log: quietLog });
  reg.add(desc('a', ['b']));
  reg.add(desc('b', ['a']));
  await reg.init(ctxFor());
  const st = Object.fromEntries(reg.status().map((r) => [r.id, r.status]));
  eq('33. registry: a dependency cycle fails both, and does not hang', `${st.a}/${st.b}`, 'failed/failed');
}

{
  const reg = makeRegistry({ bus: makeBus(), log: quietLog });
  reg.add(desc('a', [], () => { throw new Error('nope') }));
  reg.add(desc('b', ['a']));
  await reg.init(ctxFor());
  const st = Object.fromEntries(reg.status().map((r) => [r.id, r.status]));
  eq('34. registry: a module whose dependency failed is blocked, not failed', `${st.a}/${st.b}`, 'failed/blocked');

  // The null object is the whole point of failure isolation: a caller that does not check
  // gets `undefined`, not a TypeError that takes the frame down with it.
  const a = reg.get('a');
  let threw = false;
  let ret = 'unset';
  try { ret = a.anythingAtAll(1, 2, 3) } catch { threw = true }
  check('35. registry: a failed module answers as a null object', !threw && ret === undefined,
    `threw=${threw} ret=${String(ret)}`);
}

{
  const reg = makeRegistry({ bus: makeBus(), log: quietLog });
  reg.add(desc('a'));
  let threw = false;
  try { reg.add(desc('a')) } catch { threw = true }
  check('36. registry: a duplicate id is refused', threw);
}

{
  const reg = makeRegistry({ bus: makeBus(), log: quietLog });
  const inited = [];
  reg.add(desc('leaf', [], () => { inited.push('leaf'); return {} }));
  reg.add(desc('mid', ['leaf'], () => { inited.push('mid'); return {} }));
  reg.add(desc('unrelated', [], () => { inited.push('unrelated'); return {} }));
  // `?showcase=mid` boots mid and what mid needs — transitively — and nothing else.
  await reg.init(ctxFor(), { only: ['mid'] });
  eq('37. registry: only:[] pulls in the transitive closure and stops there', inited.join(','), 'leaf,mid');
}

{
  // A module that declares a dependency nothing provides is blocked, not booted: the name is
  // either a typo or a module that failed to register, and both are reasons not to run. The
  // warning in `resolveOrder` used to say "ignored", which was true of the topological sort
  // and false of the boot two functions later.
  const reg = makeRegistry({ bus: makeBus(), log: quietLog });
  reg.add(desc('a', ['nosuchmodule']));
  await reg.init(ctxFor());
  eq('38. registry: a dependency nothing provides blocks the module',
    reg.status().find((r) => r.id === 'a').status, 'blocked');
}

{
  const errs = [];
  const reg = makeRegistry({ bus: makeBus(), log: { ...quietLog, error: (m) => errs.push(m) } });
  reg.add(desc('economy'));
  // `?break=` is a *handled* path, so it may not spend §7's zero-console-error budget.
  await reg.init(ctxFor({ config: { get: (k) => (k === 'break' ? 'economy' : '') } }));
  eq('39. registry: ?break= quarantines the module', reg.status().find((r) => r.id === 'economy').status, 'failed');
  eq('40. registry: a deliberate break costs no console error', errs.length, 0);
}

// --- config -----------------------------------------------------------------
// The third bug in the `?scene=` commit: a persisted `break` would quarantine a module on
// every later boot of that browser, from a URL nobody typed.
{
  const c = makeConfig('?break=economy&showcase=tiles&scene=hunt-cave&pixelScale=3');
  eq('41. config: ?break= is read from the URL', c.get('break'), 'economy');
  eq('42. config: ?showcase= is read from the URL', c.get('showcase'), 'tiles');
  eq('43. config: ?scene= is read from the URL', c.get('scene'), 'hunt-cave');

  const written = {};
  const store = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => '{}',
    setItem: (k, v) => { written[k] = v },
    removeItem: () => {},
  };
  try {
    c.persist();
    const saved = JSON.parse(written['pokeidle.config'] ?? '{}');
    eq('44. config: break is never persisted', 'break' in saved, false);
    eq('45. config: showcase is never persisted', 'showcase' in saved, false);
    eq('46. config: scene is never persisted', 'scene' in saved, false);
    eq('47. config: an ordinary tunable IS persisted', saved.pixelScale, 3);

    // …and the same three are refused on the way back in, so a config written by an older
    // build cannot pin this one to a showcase.
    globalThis.localStorage.getItem = () => JSON.stringify({ break: 'economy', showcase: 'ui', pixelScale: 2 });
    const back = makeConfig('');
    eq('48. config: a stored break is ignored on load', back.get('break'), DEFAULTS.break);
    eq('49. config: a stored showcase is ignored on load', back.get('showcase'), DEFAULTS.showcase);
    eq('50. config: a stored tunable IS honoured on load', back.get('pixelScale'), 2);
  } finally {
    if (store === undefined) delete globalThis.localStorage; else globalThis.localStorage = store;
  }
}

{
  const c = makeConfig('?pixelsPerUnit=64&tod=19.5&nosuchkey=7');
  eq('51. config: numerics are coerced from the query string', c.get('pixelsPerUnit'), 64);
  eq('52. config: floats survive coercion', c.get('tod'), 19.5);
  eq('53. config: an unknown key is ignored', c.get('nosuchkey'), undefined);
  eq('54. config: reads like a plain object too', c.pixelsPerUnit, 64);
}

{
  const c = makeConfig('?pixelsPerUnit=notanumber');
  eq('55. config: an unparseable numeric falls back to the default',
    c.get('pixelsPerUnit'), DEFAULTS.pixelsPerUnit);
}

// --- report -----------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
console.log(`\ncore: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
