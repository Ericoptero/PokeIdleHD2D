// @ts-check
import { describe, it, expect } from 'vitest';
import { startDrag, move, drop, cancel, clampScroll } from './gesture.js';

describe('gesture: the drag/drop reducer', () => {
  it('startDrag -> move -> drop: a golden sequence of literal states', () => {
    const s1 = startDrag('mon-3', 'party-row', 10, 20);
    expect(s1).toEqual({ phase: 'drag', tag: 'party-row', payload: 'mon-3', x: 10, y: 20 });

    const s2 = move(s1, 5, -3);
    expect(s2).toEqual({ phase: 'drag', tag: 'party-row', payload: 'mon-3', x: 15, y: 17 });

    const s3 = move(s2, -2, 1);
    expect(s3).toEqual({ phase: 'drag', tag: 'party-row', payload: 'mon-3', x: 13, y: 18 });

    const s4 = drop(s3, { id: 'box-slot-9' });
    expect(s4).toEqual({ phase: 'drop', tag: 'party-row', payload: 'mon-3', x: 13, y: 18 });
  });

  it('a pointerup with no drop target under it cancels back to null', () => {
    const s1 = startDrag('mon-1', 'party-row', 0, 0);
    const s2 = move(s1, 40, 40);
    expect(drop(s2, null)).toBeNull();
    expect(drop(s2, undefined)).toBeNull();
  });

  it('a pointercancel discards the gesture regardless of accumulated motion', () => {
    let s = startDrag('mon-2', 'party-row', 0, 0);
    s = move(s, 100, -250);
    s = move(s, 9999, 9999);
    expect(cancel(s)).toBeNull();
    // Even a drag that never moved cancels the same way.
    expect(cancel(startDrag('mon-2', 'party-row'))).toBeNull();
  });

  it('move and drop pass a null/absent state through unchanged', () => {
    expect(move(null, 5, 5)).toBeNull();
    expect(drop(null, { id: 'x' })).toBeNull();
  });
});

describe('gesture: clampScroll', () => {
  it('a negative offset clamps to 0', () => {
    expect(clampScroll(-40, 300, 100)).toBe(0);
  });

  it('an offset beyond contentSize - viewSize clamps to that max', () => {
    expect(clampScroll(1000, 300, 100)).toBe(200);
  });

  it('contentSize <= viewSize always clamps to 0 — nothing to scroll', () => {
    expect(clampScroll(50, 100, 100)).toBe(0);
    expect(clampScroll(50, 80, 100)).toBe(0);
    expect(clampScroll(-10, 80, 100)).toBe(0);
  });

  it('an in-range offset passes through unchanged', () => {
    expect(clampScroll(120, 300, 100)).toBe(120);
  });
});
