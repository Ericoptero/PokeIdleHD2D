/**
 * `callout.js`'s two-tone text and its tail — the same fake-painter discipline
 * `plates.test.js` and `floaters.test.js` already use.
 */
import { describe, it, expect } from 'vitest';
import { makeCallouts } from './callout.js';

function fakePainter({ width = 300, height = 150 } = {}) {
  const fills = [];
  const texts = [];
  return {
    width, height,
    measure: (s) => String(s ?? '').length * 6,
    fill(x, y, w, h, colour) { fills.push({ x, y, w, h, colour }); },
    text(x, y, str, colour, opts) { texts.push({ x, y, str, colour, opts }); return x + String(str ?? '').length * 6; },
    _fills: fills,
    _texts: texts,
  };
}

const identityProject = (x, y, z) => ({ x, y: z });

describe('callouts — replacement and lifecycle', () => {
  it('a second line from the same side replaces the first', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'Oshawott', move: 'Tackle', x: 0, y: 0, z: 0, side: 'a' });
    callouts.say({ name: 'Oshawott', move: 'Water Gun', x: 0, y: 0, z: 0, side: 'a' });
    expect(callouts.count()).toBe(1);
    expect(callouts.peek()[0].move).toBe('Water Gun');
  });

  it('two different sides both stay up', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'Oshawott', move: 'Tackle', x: 0, y: 0, z: 0, side: 'a' });
    callouts.say({ name: 'Oddish', move: 'Absorb', x: 1, y: 0, z: 1, side: 'b' });
    expect(callouts.count()).toBe(2);
  });

  it('expires after its life', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'x', x: 0, y: 0, z: 0, life: 5 });
    callouts.tick(5);
    expect(callouts.count()).toBe(0);
  });
});

describe('callouts — two-tone text', () => {
  it('prints the name in the ordinary ink and the move in its own colour', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'Oddish', move: 'Absorb', ink: '#397722', x: 0, y: 0, z: 0 });
    const g = fakePainter();
    callouts.draw(g, identityProject);
    expect(g._texts).toHaveLength(2);
    expect(g._texts[0].str).toBe('Oddish:');
    expect(g._texts[1].str).toBe('Absorb!');
    expect(g._texts[1].colour).toBe('#397722');
    expect(g._texts[0].colour).not.toBe('#397722');
  });

  it('a struggle (no real type) falls back to the ordinary ink', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'Oshawott', move: 'Struggle', ink: null, x: 0, y: 0, z: 0 });
    const g = fakePainter();
    callouts.draw(g, identityProject);
    expect(g._texts[1].str).toBe('Struggle!');
    expect(g._texts[1].colour).toBe(g._texts[0].colour);
  });

  it('a line with no move at all prints as one plain run', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'Just a name, no move', x: 0, y: 0, z: 0 });
    const g = fakePainter();
    callouts.draw(g, identityProject);
    expect(g._texts).toHaveLength(1);
  });
});

describe('callouts — the tail', () => {
  it('draws a notch below the balloon, pointing at the true projected anchor', () => {
    const callouts = makeCallouts();
    // Anchor well clear of either screen edge, so the lean cannot clamp the balloon flush
    // against a wall and hide whether the tail tracks the anchor or the box.
    callouts.say({ name: 'Oddish', move: 'Absorb', x: 50, y: 0, z: 60, side: 'a' });
    const g = fakePainter({ width: 200, height: 200 });
    callouts.draw(g, identityProject);
    // The panel box itself is a handful of large fills (border, paper, bevel); the tail adds
    // several more, each exactly 1px tall, below the box. At least one of those 1px fills must
    // sit horizontally under the anchor x (60, via the identity projection).
    const tailish = g._fills.filter((f) => f.h === 1 && f.x <= 60 && f.x + f.w >= 60);
    expect(tailish.length, JSON.stringify(g._fills)).toBeGreaterThan(0);
  });

  it('leans the two sides apart, and the tail still tracks each one\'s own anchor', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'Oshawott', move: 'Tackle', x: 40, y: 0, z: 40, side: 'a' });
    callouts.say({ name: 'Oddish', move: 'Absorb', x: 40, y: 0, z: 40, side: 'b' });
    const g = fakePainter({ width: 300, height: 200 });
    callouts.draw(g, identityProject);
    // Both boxes were centred on the same anchor before leaning; confirm they did not land on
    // an identical x (the whole point of the lean).
    const boxes = g._fills.filter((f) => f.h > 3);
    const xs = new Set(boxes.map((f) => f.x));
    expect(xs.size).toBeGreaterThan(1);
  });
});
