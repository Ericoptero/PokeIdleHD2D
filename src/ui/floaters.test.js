/**
 * `floaters.js`'s pure lifecycle — `push()`/`tick()`/`clear()`/`peek()` — needs no DOM and
 * stays covered here. Its `draw()` now builds real `.ci-floater` elements (`css/world.css`)
 * rather than painting a fake canvas; this project verifies DOM-construction code (`dom/
 * hud.js`, `dom/feed.js`, …) through the real browser rather than jsdom (no jsdom/happy-dom
 * dependency is installed), so the floater's own position, rise and crit sizing are covered by
 * `tests/flows/balloon-effects-real-fight.spec.js` and `tests/flows/balloons-and-damage.spec.js`
 * instead.
 */
import { describe, it, expect } from 'vitest';
import { makeFloaters, FLOATER_STEPS, CRIT_FLOATER_SCALE } from './floaters.js';

describe('floaters — lifecycle', () => {
  it('starts empty', () => {
    const floaters = makeFloaters();
    expect(floaters.count()).toBe(0);
  });

  it('a pushed floater is live on the same tick, at its spawn position', () => {
    const floaters = makeFloaters();
    floaters.push({ text: '-8', x: 10, y: 0, z: 20, colour: '#ff0000' });
    expect(floaters.count()).toBe(1);
    expect(floaters.peek()[0]).toEqual(expect.objectContaining({ text: '-8', x: 10, y: 0, z: 20, colour: '#ff0000' }));
  });

  it('expires after its life', () => {
    const floaters = makeFloaters();
    floaters.push({ text: '-8', x: 10, y: 0, z: 20, life: 10 });
    floaters.tick(10);
    expect(floaters.count()).toBe(0);
  });

  it('tick() reports false once nothing is left to age', () => {
    const floaters = makeFloaters();
    expect(floaters.tick(1)).toBe(false);
    floaters.push({ text: 'x', x: 0, y: 0, z: 0, life: 5 });
    expect(floaters.tick(1)).toBe(true);
  });

  it('several floaters stack — nothing replaces another', () => {
    const floaters = makeFloaters();
    floaters.push({ text: '-4', x: 0, y: 0, z: 0 });
    floaters.push({ text: '-6', x: 0, y: 0, z: 0 });
    expect(floaters.count()).toBe(2);
  });

  it('clear() drops everything', () => {
    const floaters = makeFloaters();
    floaters.push({ text: 'x', x: 0, y: 0, z: 0 });
    floaters.clear();
    expect(floaters.count()).toBe(0);
  });

  it('a crit keeps its scale on the record, for a caller to size by', () => {
    const floaters = makeFloaters();
    floaters.push({ text: '-20', x: 0, y: 0, z: 0, tone: 'crit', scale: CRIT_FLOATER_SCALE });
    expect(floaters.peek()[0].scale).toBe(CRIT_FLOATER_SCALE);
  });

  it('FLOATER_STEPS is the default life', () => {
    const floaters = makeFloaters();
    floaters.push({ text: 'x', x: 0, y: 0, z: 0 });
    expect(floaters.peek()[0].life).toBe(FLOATER_STEPS);
  });
});
