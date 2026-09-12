// @ts-check
import { describe, it, expect } from 'vitest';
import {
  MIN_SIZE, minSizeFor, defaultBox, clampMove, clampResize, clampToSafeArea, applyMove, applyResize,
} from './window.js';

const BUFFER = { width: 640, height: 360 };
const MARGIN = 10;

describe('window: minSizeFor', () => {
  it('falls back to MIN_SIZE for a panel with no override', () => {
    expect(minSizeFor('shop')).toEqual(MIN_SIZE);
    expect(minSizeFor('party')).toBe(MIN_SIZE);
  });
});

describe('window: defaultBox', () => {
  it('centres the authored size, matching windowFrame\'s original math exactly', () => {
    expect(defaultBox(540, 278, BUFFER, MARGIN)).toEqual({ x: 50, y: 40, w: 540, h: 278 });
  });
});

describe('window: clampMove (golden literal cases)', () => {
  it('a window dragged so x would go negative clamps to the margin', () => {
    const box = { x: -50, y: 100, w: 200, h: 150 };
    expect(clampMove(box, BUFFER, MARGIN)).toEqual({ x: 10, y: 100, w: 200, h: 150 });
  });

  it('a window dragged so y would go negative clamps to the margin', () => {
    const box = { x: 100, y: -80, w: 200, h: 150 };
    expect(clampMove(box, BUFFER, MARGIN)).toEqual({ x: 100, y: 10, w: 200, h: 150 });
  });

  it('dragged past the right edge clamps so x + w never exceeds buffer.width - margin', () => {
    const box = { x: 600, y: 100, w: 200, h: 150 };
    const out = clampMove(box, BUFFER, MARGIN);
    expect(out).toEqual({ x: 430, y: 100, w: 200, h: 150 });
    expect(out.x + out.w).toBe(BUFFER.width - MARGIN);
  });

  it('dragged past the bottom edge clamps so y + h never exceeds buffer.height - margin - 2', () => {
    const box = { x: 100, y: 500, w: 200, h: 150 };
    const out = clampMove(box, BUFFER, MARGIN);
    expect(out).toEqual({ x: 100, y: 198, w: 200, h: 150 });
    expect(out.y + out.h).toBe(BUFFER.height - MARGIN - 2);
  });

  it('a box already inside the buffer passes through unchanged', () => {
    const box = { x: 50, y: 40, w: 540, h: 278 };
    expect(clampMove(box, BUFFER, MARGIN)).toEqual(box);
  });
});

describe('window: clampResize (golden literal cases)', () => {
  it('resized below the declared minimum clamps to that minimum', () => {
    const box = { x: 20, y: 20, w: 10, h: 10 };
    expect(clampResize(box, BUFFER, MARGIN, MIN_SIZE)).toEqual({ x: 20, y: 20, w: MIN_SIZE.w, h: MIN_SIZE.h });
  });

  it('resized past the buffer clamps to fit from the window\'s own top-left corner', () => {
    const box = { x: 10, y: 10, w: 5000, h: 5000 };
    const out = clampResize(box, BUFFER, MARGIN, MIN_SIZE);
    expect(out).toEqual({ x: 10, y: 10, w: 620, h: 338 });
    expect(out.x + out.w).toBe(BUFFER.width - MARGIN);
    expect(out.y + out.h).toBe(BUFFER.height - MARGIN - 2);
  });

  it('a panel-specific minimum overrides MIN_SIZE', () => {
    const min = { w: 300, h: 200 };
    const box = { x: 20, y: 20, w: 10, h: 10 };
    expect(clampResize(box, BUFFER, MARGIN, min)).toEqual({ x: 20, y: 20, w: 300, h: 200 });
  });

  it('a box already inside the buffer passes through unchanged', () => {
    const box = { x: 50, y: 40, w: 540, h: 278 };
    expect(clampResize(box, BUFFER, MARGIN, MIN_SIZE)).toEqual(box);
  });
});

describe('window: clampToSafeArea (golden literal cases — the post-review fix for the ' +
  '`uiScale:2` + `full` panel overlap the reviewer caught)', () => {
  it('with nothing reserved, a box already inside the buffer passes through unchanged', () => {
    const box = { x: 50, y: 40, w: 540, h: 278 };
    expect(clampToSafeArea(box, BUFFER, MARGIN)).toEqual(box);
  });

  it('a reserved top band pushes the box down, keeping its size', () => {
    const box = { x: 50, y: 20, w: 200, h: 150 };
    expect(clampToSafeArea(box, BUFFER, MARGIN, { top: 60, bottom: 0 }))
      .toEqual({ x: 50, y: 70, w: 200, h: 150 });
  });

  it('a reserved bottom band too tall for the box\'s own height shrinks it, then clamps y', () => {
    const box = { x: 50, y: 40, w: 540, h: 278 };
    expect(clampToSafeArea(box, BUFFER, MARGIN, { top: 0, bottom: 250 }))
      .toEqual({ x: 50, y: 10, w: 540, h: 88 });
  });

  it('reserved top and bottom together squeeze both the position and the height', () => {
    const box = { x: 50, y: 0, w: 200, h: 200 };
    expect(clampToSafeArea(box, BUFFER, MARGIN, { top: 100, bottom: 100 }))
      .toEqual({ x: 50, y: 110, w: 200, h: 138 });
  });

  it('shrinks BELOW the supplied minimum rather than overlap the reserved bands — the ' +
    'reviewer\'s own finding: a first draft floored at `min` regardless, and a real ' +
    '1080p + uiScale:2 shop window still clipped 11px into the party bar', () => {
    const box = { x: 50, y: 0, w: 200, h: 300 };
    const min = { w: 140, h: 120 };
    expect(clampToSafeArea(box, BUFFER, MARGIN, { top: 150, bottom: 150 }, min))
      .toEqual({ x: 50, y: 160, w: 200, h: 38 });
  });

  it('falls back to `min` only when the reserved bands leave no safe space at all', () => {
    const box = { x: 50, y: 0, w: 200, h: 300 };
    const min = { w: 140, h: 120 };
    // top (margin 10 + reserved 170 = 180) is already past bottom (360 - 10 - 2 - 170 = 178):
    // `available` is negative, so there is no band-respecting height to shrink to.
    expect(clampToSafeArea(box, BUFFER, MARGIN, { top: 170, bottom: 170 }, min))
      .toEqual({ x: 50, y: 180, w: 200, h: 120 });
  });
});

describe('window: applyMove / applyResize', () => {
  it('applyMove adds the delta to x/y only', () => {
    const box = { x: 50, y: 40, w: 540, h: 278 };
    expect(applyMove(box, 12, -7)).toEqual({ x: 62, y: 33, w: 540, h: 278 });
  });

  it('applyResize adds the delta to w/h only', () => {
    const box = { x: 50, y: 40, w: 540, h: 278 };
    expect(applyResize(box, 12, -7)).toEqual({ x: 50, y: 40, w: 552, h: 271 });
  });
});
