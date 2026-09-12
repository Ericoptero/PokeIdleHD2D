// @ts-check
import { describe, it, expect } from 'vitest';
import {
  MIN_SIZE, minSizeFor, defaultBox, clampMove, clampResize, applyMove, applyResize,
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
