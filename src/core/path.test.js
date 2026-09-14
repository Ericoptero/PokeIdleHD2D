/**
 * `bfsPath` (stop-one-short, for contact triggers) and `bfsCells` (inclusive, for stitching a
 * ring) share one BFS core, so the sharpest tests are the ones that would have caught the fix
 * this file just got: the "checks the entered cell, not the left one" passability bug, which let
 * a wall get tunnelled through right next to the start. Passability here is always a small
 * hand-built predicate — never terrain/draft.js — matching path.js's own "no ctx, no randomness"
 * discipline.
 */
import { describe, it, expect } from 'vitest';
import { bfsPath, bfsCells, aStar } from './path.js';
import { SOUTH, NORTH, EAST, DIR_DX, DIR_DZ } from './dir.js';

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

describe('aStar', () => {
  /** Confirms a returned step list is actually connected and legal under `canStep` — each
   * step lands on the previous cell plus its own direction's delta, and the FROM-cell was
   * allowed to step that way — then returns the final cell reached. */
  function walkSteps(from, steps, canStep) {
    let cx = from.cx, cz = from.cz;
    for (const step of steps) {
      expect(canStep(cx, cz, step.dir)).toBe(true);
      cx += DIR_DX[step.dir];
      cz += DIR_DZ[step.dir];
      expect(step.cx).toBe(cx);
      expect(step.cz).toBe(cz);
    }
    return { cx, cz };
  }

  it('walks the shortest route through an open corridor, excluding the start cell', () => {
    const canStep = () => true;
    const from = { cx: 0, cz: 0 };
    const steps = aStar(from, { cx: 5, cz: 0 }, canStep);
    expect(steps).not.toBeNull();
    expect(steps.length).toBe(5); // path cost == step count
    expect(steps[0]).toEqual({ cx: 1, cz: 0, dir: EAST });
    expect(walkSteps(from, steps, canStep)).toEqual({ cx: 5, cz: 0 });
  });

  it('routes around a wall instead of tunnelling through it', () => {
    // A wall at x=1, solid for cz -10..10 except a single gap at cz=3. canStep is a FROM-cell
    // predicate, so the wall is expressed as "you may not step INTO x=1" from either side.
    const blocked = new Set();
    for (let cz = -10; cz <= 10; cz++) if (cz !== 3) blocked.add(`1,${cz}`);
    const canStep = (cx, cz, dir) => !blocked.has(`${cx + DIR_DX[dir]},${cz + DIR_DZ[dir]}`);
    const from = { cx: 0, cz: 0 };
    const to = { cx: 2, cz: 0 };

    const steps = aStar(from, to, canStep, { maxTiles: 2000 });
    expect(steps).not.toBeNull();
    expect(walkSteps(from, steps, canStep)).toEqual(to);
    for (const s of steps) expect(blocked.has(`${s.cx},${s.cz}`)).toBe(false);
  });

  it('a one-way ledge only crosses in the allowed direction (A->B true, B->A false)', () => {
    // A = (0,0), B = (0,1) directly south of A. Dropping south off A onto B is fine (default);
    // climbing back north off B onto A is not — everything else is open.
    const canStep = (cx, cz, dir) => !(cx === 0 && cz === 1 && dir === NORTH);

    // Forward: A -> further south, straight through B, no detour needed.
    const from = { cx: 0, cz: 0 };
    const to = { cx: 0, cz: 3 };
    const forward = aStar(from, to, canStep);
    expect(forward).not.toBeNull();
    expect(forward.map((s) => s.dir)).toEqual([SOUTH, SOUTH, SOUTH]);
    expect(walkSteps(from, forward, canStep)).toEqual(to);

    // Backward: B -> A directly north is blocked, so the route must detour around it.
    const backFrom = { cx: 0, cz: 1 };
    const backTo = { cx: 0, cz: 0 };
    const backward = aStar(backFrom, backTo, canStep);
    expect(backward).not.toBeNull();
    expect(backward.length).toBeGreaterThan(1); // can't be the direct 1-step climb
    expect(walkSteps(backFrom, backward, canStep)).toEqual(backTo);
    for (let i = 0; i < backward.length - 1; i++) {
      // never the forbidden direct climb (0,1) -> NORTH as any intermediate step either.
      expect(!(backward[i].cx === 0 && backward[i].cz === 1)).toBe(true);
    }
  });

  it('returns null when start and goal are separated by a fully solid boundary', () => {
    // Nothing may step across the x=0/x=1 boundary in either direction.
    const canStep = (cx, cz, dir) => {
      const nx = cx + DIR_DX[dir];
      return !((cx === 0 && nx === 1) || (cx === 1 && nx === 0));
    };
    const steps = aStar({ cx: 0, cz: 0 }, { cx: 5, cz: 0 }, canStep, { maxTiles: 2000 });
    expect(steps).toBeNull();
  });

  it('returns null when from equals goal (matching bfsCells\'s convention)', () => {
    const canStep = () => true;
    const p = { cx: 2, cz: 3 };
    expect(aStar(p, { ...p }, canStep)).toBeNull();
  });

  it('is deterministic: repeated calls produce byte-identical output', () => {
    const canStep = () => true;
    const from = { cx: 0, cz: 0 };
    const to = { cx: 4, cz: -3 };
    const first = aStar(from, to, canStep);
    const second = aStar(from, to, canStep);
    expect(first).not.toBeNull();
    expect(first).toEqual(second);
  });

  it('breaks a genuine f-score tie by discovery order, not incidentally', () => {
    // From (0,0) to (2,2) on an open grid: expanding the start, SOUTH (g=1,h=3,f=4) and EAST
    // (g=1,h=3,f=4) tie exactly, while WEST and NORTH are strictly worse (f=6). SOUTH is
    // examined before EAST in the fixed neighbour order (0..3), so it is pushed to the open
    // set with a lower sequence number and must be the one expanded first on the tie.
    const canStep = () => true;
    const from = { cx: 0, cz: 0 };
    const to = { cx: 2, cz: 2 };
    const steps = aStar(from, to, canStep);
    expect(steps).not.toBeNull();
    expect(steps.length).toBe(4); // Manhattan distance — no wasted steps
    expect(steps[0].dir).toBe(SOUTH); // the tie resolves to the earlier-discovered neighbour
    expect(walkSteps(from, steps, canStep)).toEqual(to);

    // And the tie-break is stable across calls, not a one-off accident of this run.
    expect(aStar(from, to, canStep)).toEqual(steps);
  });
});
