/**
 * `stitchLoop` — the authored-first ring stitcher (`compose.js`), pinned against hand-built
 * `MapDraft`s the way `hunts/selftest.js`'s own `findLoop`/`slotsForLoop` pins already do (see
 * "A hand-built room" there): a small walkable rectangle with a solid obstacle in the middle,
 * built with `new MapDraft(...)` and `setCollision`. `MapDraft` is taken off `terrain`'s
 * published API rather than imported from `terrain/draft.js` directly, for the same reason
 * `selftest.js` does it: a cross-module deep import is banned even in a test.
 */
import { describe, it, expect } from 'vitest';
import { stitchLoop, isClosedWalk } from './compose.js';
import terrainModule from '../terrain/index.js';

const stubCtx = {
  bus: { emit() {}, on: () => () => {}, once() {} },
  log: { info() {}, warn() {}, error() {} },
  get: () => ({ __missing: true }),
};
const { MapDraft } = terrainModule.init(stubCtx);

/** A hand-built room: a walkable rectangle with a solid pillar in the middle. */
function room() {
  const draft = new MapDraft({ id: 'stitch-test', w: 24, h: 20, seed: 1 });
  for (let z = 1; z < 19; z++) for (let x = 1; x < 23; x++) draft.setCollision(x, z, 'walk');
  for (let z = 8; z < 12; z++) for (let x = 10; x < 14; x++) draft.setCollision(x, z, 'block');
  return draft;
}

describe('stitchLoop', () => {
  it('stitches a clean ring around the obstacle from three waypoints', () => {
    const draft = room();
    const points = [
      { cx: 12, cz: 3 },   // north of the pillar
      { cx: 21, cz: 15 },  // south-east, around it
      { cx: 3, cz: 15 },   // south-west, around it
    ];
    const loop = stitchLoop(draft, points, { margin: 1, straightLead: 4 });
    expect(loop).not.toBeNull();
    expect(isClosedWalk(draft, loop.cells)).toBe(true);
    expect(loop.source).toBe('authored');

    // The opening straight run is at least `straightLead` long — checked the same way
    // `stitchLoop` itself checks it, independently of `rotateToStraight`'s silent no-op.
    const dirBetween = (a, b) => {
      if (b.cx > a.cx) return 'e';
      if (b.cx < a.cx) return 'w';
      return b.cz > a.cz ? 's' : 'n';
    };
    const n = loop.cells.length;
    const dir0 = dirBetween(loop.cells[0], loop.cells[1]);
    let lead = 0;
    while (lead < 4 && dirBetween(loop.cells[lead % n], loop.cells[(lead + 1) % n]) === dir0) lead++;
    expect(lead).toBeGreaterThanOrEqual(4);
  });

  it('also stitches a clean ring from four waypoints', () => {
    const draft = room();
    const points = [
      { cx: 12, cz: 3 },
      { cx: 21, cz: 9 },
      { cx: 12, cz: 15 },
      { cx: 3, cz: 9 },
    ];
    const loop = stitchLoop(draft, points, { margin: 1, straightLead: 4 });
    expect(loop).not.toBeNull();
    expect(isClosedWalk(draft, loop.cells)).toBe(true);
    expect(loop.source).toBe('authored');
  });

  it('prefers an elbow leg over a BFS staircase when a clean elbow exists', () => {
    const draft = room();
    // A -> B is a straight line with no obstacle on it at all: both elbow arms are open, so
    // the leg is built by `elbowLeg`, not `bfsCells`. An elbow bends at most once per leg (two
    // legs meeting corner to corner can add a second turn where they join) — a BFS leg picking
    // its way around the jagged edge of a room would bend many times over the same span.
    const points = [
      { cx: 3, cz: 3 },
      { cx: 20, cz: 3 },   // straight east along z=3, well clear of the pillar (z 8-11)
      { cx: 20, cz: 15 },
      { cx: 3, cz: 15 },
    ];
    const loop = stitchLoop(draft, points, { margin: 1, straightLead: 4 });
    expect(loop).not.toBeNull();
    // A rectangle-ish ring through four corners has four corners; nowhere near the dozens a
    // staircased leg would add.
    expect(loop.corners).toBeLessThanOrEqual(8);
  });

  it('rejects a waypoint order that makes the ring revisit a cell', () => {
    const draft = room();
    const rejections = [];
    // Three collinear points on the same open row: b sits between a and c, so the leg
    // a -> b -> c -> a walks east over cells the c -> a leg then walks right back over.
    const points = [
      { cx: 3, cz: 3 },
      { cx: 12, cz: 3 },
      { cx: 20, cz: 3 },
    ];
    const loop = stitchLoop(draft, points, {
      margin: 1,
      straightLead: 4,
      onReject: (reason) => rejections.push(reason),
    });
    expect(loop).toBeNull();
    expect(rejections.length).toBe(1);
    expect(rejections[0]).toMatch(/revisits/);
  });

  it('reports a failed leg when a waypoint is sealed off on every side', () => {
    const draft = room();
    // Surround (12, 3) with solid collision on all four (and diagonal) neighbours, so no leg
    // can reach or leave it.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        draft.setCollision(12 + dx, 3 + dz, 'block');
      }
    }
    const failures = [];
    const points = [
      { cx: 12, cz: 3 },   // sealed
      { cx: 20, cz: 15 },
      { cx: 3, cz: 15 },
    ];
    const loop = stitchLoop(draft, points, {
      margin: 1,
      straightLead: 4,
      onLegFailed: (info) => failures.push(info),
    });
    expect(loop).toBeNull();
    expect(failures.length).toBe(1);
    // The leg leaving the sealed waypoint (index 0: points[0] -> points[1]) is the one that
    // fails first — pinning that `stitchLoop` reports failure rather than silently producing a
    // broken ring, which is `hunts/index.js`'s job to fall back from, not this function's job
    // to paper over.
    expect(failures[0].index).toBe(0);
    expect(failures[0].from).toEqual({ cx: 12, cz: 3 });
  });

  it('returns null with fewer than three waypoints', () => {
    const draft = room();
    expect(stitchLoop(draft, [], { margin: 1 })).toBeNull();
    expect(stitchLoop(draft, [{ cx: 3, cz: 3 }], { margin: 1 })).toBeNull();
    expect(stitchLoop(draft, [{ cx: 3, cz: 3 }, { cx: 20, cz: 3 }], { margin: 1 })).toBeNull();
  });
});
