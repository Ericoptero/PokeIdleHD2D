/**
 * `callout.js`'s pure lifecycle — `say()`'s replace-by-side rule and `tick()`'s expiry — needs
 * no DOM and stays covered here. Its `draw()` now builds real `.ci-balloon` elements
 * (`css/world.css`) rather than painting a fake canvas; this project verifies DOM-construction
 * code (`dom/hud.js`, `dom/feed.js`, …) through the real browser rather than jsdom (no jsdom/
 * happy-dom dependency is installed), so the balloon's own text, lean and tail are covered by
 * `tests/flows/balloon-effects-real-fight.spec.js` and `tests/flows/balloons-and-damage.spec.js`
 * instead.
 */
import { describe, it, expect } from 'vitest';
import { makeCallouts } from './callout.js';

describe('callouts — replacement and lifecycle', () => {
  it('a second line from the same side replaces the first', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'Oshawott', verb: 'use', move: 'Tackle', x: 0, y: 0, z: 0, side: 'a' });
    callouts.say({ name: 'Oshawott', verb: 'use', move: 'Water Gun', x: 0, y: 0, z: 0, side: 'a' });
    expect(callouts.count()).toBe(1);
    expect(callouts.peek()[0].move).toBe('Water Gun');
  });

  it('two different sides both stay up', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'Oshawott', verb: 'use', move: 'Tackle', x: 0, y: 0, z: 0, side: 'a' });
    callouts.say({ name: 'Oddish', verb: 'uses', move: 'Absorb', x: 1, y: 0, z: 1, side: 'b' });
    expect(callouts.count()).toBe(2);
  });

  it('expires after its life', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'x', x: 0, y: 0, z: 0, life: 5 });
    callouts.tick(5);
    expect(callouts.count()).toBe(0);
  });

  it('a swap line carries no move, and the verb defaults are the caller\'s to set', () => {
    const callouts = makeCallouts();
    callouts.say({ name: 'Oshawott, I choose you!', x: 0, y: 0, z: 0, side: 'a' });
    expect(callouts.peek()[0]).toEqual(expect.objectContaining({ name: 'Oshawott, I choose you!', move: null }));
  });
});
