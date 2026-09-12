/**
 * The balloon's per-type colour and the damage floater, proven against a real
 * fight rather than the fake painter `src/ui/callout.test.js`/`floaters.test.js` use — those
 * pin the drawing geometry; this pins that a real `battle:strike` actually reaches both and
 * carries the right content.
 *
 * `_callouts`/`_floaters` are read straight off the page: `bus.on('battle:strike', …)` runs
 * synchronously inside `registry.tick()`, the same pass `__HOOKS__.step()` drives, so — unlike
 * `ui/plates.js`, which is gathered in the render-rate `lateFrame` hook and needs its own
 * forcing seam — an ordinary `step()` is enough to see both update.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, step, events } from './harness.js';

/** Reads the plain data both hold — `peek()` is exactly this file's own reason to exist. */
const peekUi = (page, key) => page.evaluate((k) => window.__CTX__.get('ui')?.[k]?.peek?.() ?? [], key);

test('a real strike colours the move by its type, and drops a damage number on the target', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  // Walk to a fight and step a little way into it — enough for at least one real move to land.
  let ticks = 0;
  for (;;) {
    const log = await events(page);
    const strikes = log.filter((e) => e.type === 'battle:strike' && e.payload.damage > 0);
    if (strikes.length) break;
    expect(ticks, 'no damaging strike within 3000 ticks').toBeLessThan(3000);
    await step(page, 6);
    ticks += 6;
  }

  const log = await events(page);
  const hit = log.find((e) => e.type === 'battle:strike' && e.payload.damage > 0);
  expect(hit, 'a damaging strike is on the bus').toBeTruthy();
  expect(hit.payload.type, 'the strike carries its element').toEqual(expect.any(String));

  // 1. The balloon: the move's name run should exist, and its ink should be the type's own —
  // never the balloon's own paper colour, and never plain black/ink for a real type.
  const typeInk = await page.evaluate((t) => window.__CTX__.get('battle')?.typeColour?.(t)?.ink ?? null, hit.payload.type);
  expect(typeInk, 'battle.typeColour resolves for a real move type').toEqual(expect.any(String));

  const lines = await peekUi(page, '_callouts');
  const line = lines.find((l) => l.move === hit.payload.name || (hit.payload.struggle && l.move === 'Struggle'));
  expect(line, `a callout exists for "${hit.payload.name}" among ${JSON.stringify(lines)}`).toBeTruthy();
  if (!hit.payload.struggle) expect(line.ink).toBe(typeInk);

  // 2. The floater: a "-N" over the target, matching the strike's own damage exactly.
  const floats = await peekUi(page, '_floaters');
  const dmg = floats.find((f) => f.text === `-${hit.payload.damage}`);
  expect(dmg, `a "-${hit.payload.damage}" floater exists among ${JSON.stringify(floats)}`).toBeTruthy();
  // Crit doubles the floater's own size — never the ordinary case.
  expect(dmg.scale).toBe(hit.payload.crit ? 2 : 1);

  expect(errors, 'no console error while balloons and floaters read a real fight').toEqual([]);
});
