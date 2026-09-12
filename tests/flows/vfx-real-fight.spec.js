/**
 * Shader VFX exercised during a real battle, including visibility and frame-hook wiring.
 *
 * Two properties nothing else in the suite reaches:
 *
 *   1. **The three VFX meshes actually exist and go visible in a REAL (non-showcase) fight.**
 *      `elements.test.js` and `src/encounter/selftest.js` only exercise the pure
 *      `profileFor`/`beatAt`/`BEATS` tables — none of them ever boots `three` or calls
 *      `play.js`'s `makeStrikeVfx`, and the showcase's own `stageStrike` tool is a manufactured
 *      call, not a strike the battle engine actually produced. This drives a real duel on
 *      `?scene=hunt-meadow&seed=1337`
 *      and reads the three meshes by the names `play.js`'s sub-modules give them
 *      (`encounter:vfx:particles`, `encounter:vfx:beam`, `encounter:vfx:ground`) straight off
 *      `ctx.three.scene`, the one seam a flow is allowed to reach into three.js through
 *      (src/main.js — flows read bus events and module state, and a mesh's own `.visible`
 *      is state, not a pixel).
 *   2. **The `frame`→`lateFrame` rename is a real rename, not a duplicate.**
 *      `src/main.js`'s frame loop runs unconditionally off `requestAnimationFrame` regardless
 *      of `__HOOKS__.pause()` (`tests/flows/plates.spec.js`'s own header notes this: `step()`
 *      only drives `registry.tick`, never `frame`/`lateFrame`) — so if the rename had left a
 *      stale `frame` key as well as the new `lateFrame` one, `registry.run('frame', …)` would
 *      still find and call it, and a test that only watches the ball for visible breakage
 *      would not tell the two apart. Reading `registry.descriptor('encounter')` directly does.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, step, events, key } from './harness.js';

const VFX_NAMES = ['encounter:vfx:particles', 'encounter:vfx:beam', 'encounter:vfx:ground'];

/** Every named VFX mesh's current `.visible`, straight off the live three.js scene graph. */
const vfxVisibility = (page) => page.evaluate((names) => {
  const scene = window.__CTX__.three.scene;
  return Object.fromEntries(names.map((n) => [n, scene.getObjectByName(n)?.visible ?? null]));
}, VFX_NAMES);

test('a real strike in a real fight puts all three named VFX meshes in the scene, and at least one goes visible, with zero console errors', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  // The three meshes are built once, at module init, and simply stay `visible = false` when
  // nothing is playing (zero draw calls while idle) — so they must exist in
  // the graph from the very first frame, before any fight has even started.
  const initial = await vfxVisibility(page);
  for (const n of VFX_NAMES) {
    expect(initial[n], `mesh "${n}" exists in ctx.three.scene before any strike`).not.toBeNull();
    expect(initial[n], `mesh "${n}" starts hidden, nothing is playing yet`).toBe(false);
  }

  // Walk the world forward to the first real encounter, then into its duel.
  let ticks = 0;
  for (;;) {
    const log = await events(page);
    if (log.some((e) => e.type === 'encounter:started')) break;
    expect(ticks, 'no encounter:started within 3000 ticks').toBeLessThan(3000);
    await step(page, 12);
    ticks += 12;
  }

  // Sample VFX visibility after every small chunk while strikes are landing. A real duel
  // strikes every `ACTION_STEPS` (18) ticks (`battle/selftest.js` #54), so a 6-tick chunk
  // samples well inside that window without ever needing to catch one exact tick.
  let sawAnyVisible;
  let strikeSeen;
  ticks = 0;
  for (;;) {
    const log = await events(page);
    strikeSeen = log.filter((e) => e.type === 'battle:strike').length;
    const vis = await vfxVisibility(page);
    if (Object.values(vis).some((v) => v === true)) { sawAnyVisible = true; break; }
    expect(ticks, `no VFX mesh ever went visible within 2000 ticks of the duel starting `
      + `(${strikeSeen} battle:strike events seen so far)`).toBeLessThan(2000);
    await step(page, 6);
    ticks += 6;
  }
  expect(sawAnyVisible, 'at least one of particles/beam/ground went visible during a real strike').toBe(true);
  expect(strikeSeen, 'sanity: the duel actually produced at least one real strike by then').toBeGreaterThan(0);

  expect(errors, 'zero console errors while a real strike drove the VFX system').toEqual([]);
});

test('the encounter module answers to `lateFrame`, not `frame`, at the registry', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  const hooks = await page.evaluate(() => {
    const d = window.__CTX__.registry.descriptor('encounter');
    return { hasFrame: typeof d?.frame, hasLateFrame: typeof d?.lateFrame };
  });
  expect(hooks.hasLateFrame, 'encounter\'s render-rate hook is registered under lateFrame').toBe('function');
  expect(hooks.hasFrame, 'the old `frame` key is gone, not left behind as a stale duplicate').toBe('undefined');

  expect(errors).toEqual([]);
});

test('a real thrown ball still renders through lateFrame end to end (no showcase, no stageStrike)', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  // Walk to a real encounter and let its duel run to a real, decided end.
  let ticks = 0;
  let ended;
  for (;;) {
    const log = await events(page);
    const hit = log.find((e) => e.type === 'battle:ended');
    if (hit) { ended = hit; break; }
    expect(ticks, 'no battle:ended within 3000 ticks').toBeLessThan(3000);
    await step(page, 12);
    ticks += 12;
  }
  expect(ended.payload.won, 'sanity: this duel actually needs to be won to reach a throw').toBe(true);

  // Throw, the way a player actually does it — `KeyZ` (`src/ui/input.js`), not
  // `encounter.attempt()` called directly, which is what the showcase does instead.
  await step(page, 4);
  await key(page, 'KeyZ');

  // Wait for the ball to actually be airborne (`scene().stage === 'throw'`).
  ticks = 0;
  for (;;) {
    const stage = await page.evaluate(() => window.__CTX__.get('encounter').scene()?.stage);
    if (stage === 'throw') break;
    expect(ticks, `never reached the 'throw' stage within 400 ticks of pressing KeyZ (last stage seen: ${stage})`)
      .toBeLessThan(400);
    await step(page, 4);
    ticks += 4;
  }

  // The ball mesh is named `encounter:ball` (`ball.js`); read it straight off the scene graph.
  const ball = await page.evaluate(() => {
    const m = window.__CTX__.three.scene.getObjectByName('encounter:ball');
    if (!m) return null;
    return { visible: m.visible, scale: m.scale.x, y: m.position.y };
  });
  expect(ball, 'the ball mesh exists in the scene graph while a real ball is airborne').not.toBeNull();
  expect(ball.visible, 'the ball is visible mid-throw').toBe(true);
  // `gridScale`'s own correction is small by design (~6% at most, per ball.js's own header) —
  // a scale outside this band would mean `refit()` (driven by the renamed `lateFrame` hook)
  // stopped being called, or is feeding `place()` something broken.
  expect(ball.scale, 'the airborne ball keeps a sane, finite pixel-grid scale').toBeGreaterThan(0.5);
  expect(ball.scale).toBeLessThan(2);
  expect(Number.isFinite(ball.y), 'the ball has a real, finite height mid-arc').toBe(true);

  expect(errors, 'zero console errors while a real ball was thrown end to end').toEqual([]);
});
