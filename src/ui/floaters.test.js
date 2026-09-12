/**
 * `floaters.js`'s pure geometry and lifecycle — the same discipline `plates.test.js` already
 * applies to `plates.js`: a fake painter and an identity projection, no canvas, no `ctx`.
 */
import { describe, it, expect } from 'vitest';
import { makeFloaters, FLOATER_STEPS, CRIT_FLOATER_SCALE } from './floaters.js';

/** Just enough of the painter for `draw()`: records every text/textScaled call. */
function fakePainter({ width = 200, height = 100 } = {}) {
  const texts = [];
  const scaled = [];
  return {
    width, height,
    measure: (s) => String(s ?? '').length * 6,
    fill() {},
    text(x, y, str, colour, opts) { texts.push({ x, y, str, colour, opts }); return x + String(str ?? '').length * 6; },
    textScaled(x, y, str, colour, scale, opts) { scaled.push({ x, y, str, colour, scale, opts }); return x; },
    _texts: texts,
    _scaled: scaled,
  };
}

const identityProject = (x, y, z) => ({ x, y: z });

describe('floaters — lifecycle', () => {
  it('draws nothing before anything is pushed', () => {
    const floaters = makeFloaters();
    const g = fakePainter();
    floaters.draw(g, identityProject);
    expect(g._texts.length).toBe(0);
  });

  it('draws a pushed floater at its spawn position on the same tick', () => {
    const floaters = makeFloaters();
    floaters.push({ text: '-8', x: 10, y: 0, z: 20, colour: '#ff0000' });
    const g = fakePainter();
    floaters.draw(g, identityProject);
    expect(g._texts).toHaveLength(1);
    expect(g._texts[0].str).toBe('-8');
    expect(g._texts[0].colour).toBe('#ff0000');
  });

  it('rises over its lifetime — later ticks draw higher up (smaller y)', () => {
    const floaters = makeFloaters();
    floaters.push({ text: '-8', x: 10, y: 0, z: 20 });
    const g = fakePainter();
    floaters.draw(g, identityProject);
    const y0 = g._texts[0].y;
    floaters.tick(FLOATER_STEPS / 2);
    const g2 = fakePainter();
    floaters.draw(g2, identityProject);
    expect(g2._texts[0].y).toBeLessThan(y0);
  });

  it('expires after its life and stops drawing', () => {
    const floaters = makeFloaters();
    floaters.push({ text: '-8', x: 10, y: 0, z: 20, life: 10 });
    floaters.tick(10);
    const g = fakePainter();
    floaters.draw(g, identityProject);
    expect(g._texts.length).toBe(0);
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
});

describe('floaters — crit emphasis', () => {
  it('draws a scale > 1 floater through textScaled, not text', () => {
    const floaters = makeFloaters();
    floaters.push({ text: '-20', x: 0, y: 0, z: 0, scale: CRIT_FLOATER_SCALE });
    const g = fakePainter();
    floaters.draw(g, identityProject);
    expect(g._texts.length).toBe(0);
    expect(g._scaled).toHaveLength(1);
    expect(g._scaled[0].scale).toBe(CRIT_FLOATER_SCALE);
    expect(g._scaled[0].str).toBe('-20');
  });

  it('an ordinary (scale 1) floater uses text, not textScaled', () => {
    const floaters = makeFloaters();
    floaters.push({ text: '-4', x: 0, y: 0, z: 0, scale: 1 });
    const g = fakePainter();
    floaters.draw(g, identityProject);
    expect(g._scaled.length).toBe(0);
    expect(g._texts).toHaveLength(1);
  });
});

describe('floaters — off-screen and clamping', () => {
  it('skips a floater the projection refuses (behind the camera)', () => {
    const floaters = makeFloaters();
    floaters.push({ text: 'x', x: 0, y: 0, z: 0 });
    const g = fakePainter();
    floaters.draw(g, () => null);
    expect(g._texts.length).toBe(0);
  });

  it('clamps a floater inside the buffer rather than drawing off it', () => {
    const floaters = makeFloaters();
    floaters.push({ text: 'MISS', x: 0, y: 0, z: 0 });
    const g = fakePainter({ width: 40 });
    // Project far to the right of a narrow buffer.
    floaters.draw(g, () => ({ x: 500, y: 50 }));
    expect(g._texts[0].x).toBeLessThanOrEqual(40 - g.measure('MISS') - 2);
  });
});
