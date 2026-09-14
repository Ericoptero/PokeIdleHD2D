/**
 * `canStep` adds an elevation rule on top of `passable()`'s destination-only check: normal
 * ground only connects at the same height, stairs bridge a height change either way, and a
 * ledge needs no extra elevation check since stepping onto one is itself the descent.
 *
 * No hunt map calls setHeight today (every shipped map is flat), so the elevation branch here
 * is exercised only against a hand-built MapDraft — this file is what actually observes it.
 */
import { describe, it, expect } from 'vitest';
import { MapDraft } from './draft.js';
import { SOUTH, NORTH } from '../core/dir.js';

function flatDraft() {
  const d = new MapDraft({ id: 'canstep-test', w: 8, h: 8 });
  for (let cz = 0; cz < d.h; cz++) {
    for (let cx = 0; cx < d.w; cx++) d.setCollision(cx, cz, 'walk');
  }
  return d;
}

describe('MapDraft.canStep', () => {
  it('allows stepping between two cells at the same elevation', () => {
    const d = flatDraft();
    expect(d.canStep(3, 3, SOUTH)).toBe(true);
  });

  it('refuses a height difference with no stairs involved', () => {
    const d = flatDraft();
    d.setHeight(3, 4, 1.0); // destination cell for a SOUTH step from (3,3)
    expect(d.canStep(3, 3, SOUTH)).toBe(false);
  });

  it('lets stairs bridge two heights in either direction', () => {
    const d = flatDraft();
    d.setHeight(3, 4, 1.0);
    d.setCollision(3, 4, 'stairs');
    expect(d.canStep(3, 3, SOUTH)).toBe(true); // stepping up onto the stairs
    expect(d.canStep(3, 4, NORTH)).toBe(true); // stepping back down off the stairs
  });

  it('allows a one-way ledge only in its permitted direction', () => {
    const d = flatDraft();
    d.setCollision(3, 4, 'ledge');
    d.addTag(3, 4, `ledge:${SOUTH}`);
    expect(d.canStep(3, 3, SOUTH)).toBe(true); // dropping in from the north, as tagged
    expect(d.canStep(3, 5, NORTH)).toBe(false); // approaching against the ledge's own direction
  });

  it('refuses a blocked destination, matching passable()\'s own refusal', () => {
    const d = flatDraft();
    d.setCollision(3, 4, 'block');
    expect(d.passable(3, 4, SOUTH)).toBe(false);
    expect(d.canStep(3, 3, SOUTH)).toBe(false);
  });
});
