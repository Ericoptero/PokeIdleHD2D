/**
 * `bfsPath` (stop-one-short, for contact triggers) and `bfsCells` (inclusive, for stitching a
 * ring) share one BFS core, so the sharpest tests are the ones that would have caught the fix
 * this file just got: the "checks the entered cell, not the left one" passability bug, which let
 * a wall get tunnelled through right next to the start. Passability here is always a small
 * hand-built predicate — never terrain/draft.js — matching path.js's own "no ctx, no randomness"
 * discipline.
 */
import { describe, it, expect } from 'vitest';
import { bfsPath, bfsCells } from './path.js';
import { SOUTH, EAST, DIR_DX, DIR_DZ } from './dir.js';

/** Reconstructs the cell sequence `bfsPath` walked, from its returned dirs. */
function walk(from, dirs) {
  const cells = [{ cx: from.cx, cz: from.cz }];
  let cx = from.cx, cz = from.cz;
  for (const dir of dirs) {
    cx += DIR_DX[dir];
    cz += DIR_DZ[dir];
    cells.push({ cx, cz });
  }
  return cells;
}

describe('bfsPath', () => {
  it('walks the shortest route through an open corridor, stopping one cell short', () => {
    const passable = () => true;
    const dirs = bfsPath({ cx: 0, cz: 0 }, { cx: 5, cz: 0 }, passable);
    expect(dirs).toEqual([EAST, EAST, EAST, EAST]);
  });

  it('routes around a wall instead of tunnelling through it (regression)', () => {
    // A wall at x=1, solid for cz -10..10 except a single gap at cz=3.
    const blocked = new Set();
    for (let cz = -10; cz <= 10; cz++) if (cz !== 3) blocked.add(`1,${cz}`);
    const passable = (cx, cz) => !blocked.has(`${cx},${cz}`);
    const from = { cx: 0, cz: 0 };
    const to = { cx: 2, cz: 0 };

    const dirs = bfsPath(from, to, passable, 1000);
    expect(dirs).not.toBeNull();

    const cells = walk(from, dirs);
    for (const c of cells) expect(blocked.has(`${c.cx},${c.cz}`)).toBe(false);

    const last = cells[cells.length - 1];
    expect(Math.max(Math.abs(last.cx - to.cx), Math.abs(last.cz - to.cz))).toBeLessThanOrEqual(1);
  });

  it('returns null when two rooms are separated by a fully solid wall', () => {
    const passable = (cx) => cx !== 1; // x=1 blocked everywhere — no gap, ever.
    const dirs = bfsPath({ cx: 0, cz: 0 }, { cx: 5, cz: 0 }, passable, 300);
    expect(dirs).toBeNull();
  });

  it('returns null when the start is already adjacent to the target', () => {
    const passable = () => true;
    expect(bfsPath({ cx: 0, cz: 0 }, { cx: 1, cz: 0 }, passable)).toBeNull();
  });
});

describe('bfsCells', () => {
  it('lands exactly on the target, inclusive of the start cell', () => {
    const passable = () => true;
    const cells = bfsCells({ cx: 0, cz: 0 }, { cx: 3, cz: 0 }, passable);
    expect(cells).toEqual([
      { cx: 0, cz: 0 },
      { cx: 1, cz: 0 },
      { cx: 2, cz: 0 },
      { cx: 3, cz: 0 },
    ]);
  });

  it('returns null when the target cell itself is impassable', () => {
    const passable = (cx, cz) => !(cx === 2 && cz === 0);
    const cells = bfsCells({ cx: 0, cz: 0 }, { cx: 2, cz: 0 }, passable);
    expect(cells).toBeNull();
  });

  it('a one-way ledge only crosses in the allowed direction', () => {
    // Row cz=2 is a ledge: only enterable by dropping in from the north (dir SOUTH) — not from
    // the side, and not climbed back up from the south.
    const passable = (cx, cz, dir) => (cz === 2 ? dir === SOUTH : true);
    const from = { cx: -3, cz: 0 };
    const to = { cx: 3, cz: 4 };

    const cells = bfsCells(from, to, passable, { maxTiles: 5000 });
    expect(cells).not.toBeNull();
    expect(cells[cells.length - 1]).toEqual(to);

    for (let i = 1; i < cells.length; i++) {
      const prev = cells[i - 1];
      const cur = cells[i];
      if (cur.cz !== 2) continue;
      expect(cur.cx - prev.cx).toBe(DIR_DX[SOUTH]);
      expect(cur.cz - prev.cz).toBe(DIR_DZ[SOUTH]);
    }
  });

  it('returns the same route on repeated calls with the same input (determinism)', () => {
    const passable = () => true;
    const from = { cx: 0, cz: 0 };
    const to = { cx: 4, cz: -2 };
    const first = bfsCells(from, to, passable);
    const second = bfsCells(from, to, passable);
    expect(first).not.toBeNull();
    expect(first).toEqual(second);
  });

  it('returns null when from equals to', () => {
    const passable = () => true;
    const p = { cx: 2, cz: 3 };
    expect(bfsCells(p, { ...p }, passable)).toBeNull();
  });
});
