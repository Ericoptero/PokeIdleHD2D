/**
 * `patrol.js` pinned against hand-built `MapDraft`s, the way `hunts/loop.test.js` already
 * pins `stitchLoop` (see that file's own top-of-file note): `MapDraft` comes off
 * `terrainModule.init(stubCtx)`, never a deep import into `terrain/draft.js`, so this test
 * exercises the exact same `canStep`/`passable`/ledge semantics production code will hand
 * `chooseTarget` and `standTiles`.
 *
 * One test per numbered rule in the patrol spec, in spec order, plus the headline behavior
 * (real-walking-distance beats straight-line distance) that is the entire reason this module
 * routes spawn selection through `aStar` instead of a `manhattan` sort.
 */
import { describe, it, expect } from 'vitest';
import { standTiles, chooseTarget, makePatrol } from './patrol.js';
import { aStar } from '../core/path.js';
import { SOUTH } from '../core/dir.js';
import terrainModule from '../terrain/index.js';

const stubCtx = {
  bus: { emit() {}, on: () => () => {}, once() {} },
  log: { info() {}, warn() {}, error() {} },
  get: () => ({ __missing: true }),
};
const { MapDraft } = terrainModule.init(stubCtx);

/** An open, fully walkable rectangle — the default fixture for tests that add their own
 * obstacles on top rather than reusing a shared pillar. */
function room(w, h) {
  const draft = new MapDraft({ id: 'patrol-test', w, h, seed: 1 });
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) draft.setCollision(x, z, 'walk');
  return draft;
}

describe('makePatrol', () => {
  it('rule: a waypoint counts as visited within Manhattan 3, not only on its exact cell', () => {
    const patrol = makePatrol({ waypoints: [{ cx: 5, cz: 5 }] });
    expect(patrol.arrived({ cx: 5, cz: 5 })).toBe(true); // exact cell
    expect(patrol.arrived({ cx: 8, cz: 5 })).toBe(true); // Manhattan 3, still counts
    expect(patrol.arrived({ cx: 5, cz: 2 })).toBe(true); // Manhattan 3 the other axis
    expect(patrol.arrived({ cx: 9, cz: 5 })).toBe(false); // Manhattan 4, too far
  });

  it('rule 6: a waypoint at the walker\'s own tile, or unreachable, falls through via skip()', () => {
    const draft = room(20, 20);
    const canStep = draft.canStep.bind(draft);
    const patrol = makePatrol({ waypoints: [{ cx: 5, cz: 5 }, { cx: 15, cz: 5 }] });

    // Case A: the walker is already standing on the current waypoint's own cell. `aStar`
    // has nothing to walk (from === goal) -- the "current tile" half of the rule -- so the
    // caller's fallback is to skip to the next waypoint instead of treating this as an error.
    const at = { cx: 5, cz: 5 };
    expect(aStar(at, patrol.current(), canStep)).toBeNull();
    const step = patrol.skip();
    expect(step.wrapped).toBe(false);
    expect(patrol.current()).toEqual({ cx: 15, cz: 5 });

    // Case B: the new current waypoint is sealed off on every side -- the "cannot be
    // reached" half of the rule -- so `aStar` finds no route at all, and the same skip()
    // fallback applies.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        draft.setCollision(15 + dx, 5 + dz, 'block');
      }
    }
    expect(aStar({ cx: 2, cz: 2 }, patrol.current(), canStep)).toBeNull();
  });

  it('rule: laps increments exactly once per full pass, including a wrap caused by skip()', () => {
    const patrol = makePatrol({ waypoints: [{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }, { cx: 2, cz: 0 }] });
    expect(patrol.laps).toBe(0);

    expect(patrol.advance()).toEqual({ laps: 0, wrapped: false }); // index 0 -> 1
    expect(patrol.skip()).toEqual({ laps: 0, wrapped: false }); // index 1 -> 2, via skip
    const wrap = patrol.skip(); // index 2 -> 0: a full pass, completed by a skip
    expect(wrap).toEqual({ laps: 1, wrapped: true });
    expect(patrol.laps).toBe(1);
    expect(patrol.index).toBe(0);

    // A second full pass, mixing advance() and skip(), ticks laps to 2 -- not to 3 or more,
    // so laps really is "one per full pass" and not a per-step counter in disguise.
    patrol.advance();
    patrol.skip();
    expect(patrol.laps).toBe(1);
    patrol.advance();
    expect(patrol.laps).toBe(2);
  });
});

describe('standTiles', () => {
  it('rule: generates the four orthogonal stand tiles, never a diagonal', () => {
    const draft = room(20, 20);
    const canStep = draft.canStep.bind(draft);
    const spawn = { cx: 10, cz: 10 };
    const tiles = standTiles(spawn, canStep);
    // Fixed south, west, north, east order (core/dir.js's own 0,1,2,3).
    expect(tiles).toEqual([
      { cx: 10, cz: 11 },
      { cx: 9, cz: 10 },
      { cx: 10, cz: 9 },
      { cx: 11, cz: 10 },
    ]);
    for (const t of tiles) {
      const dx = Math.abs(t.cx - spawn.cx);
      const dz = Math.abs(t.cz - spawn.cz);
      expect(dx + dz).toBe(1); // orthogonal only -- a diagonal would be dx===1 && dz===1
    }
  });

  it('rule: a stand tile legal to enter but illegal to leave (a one-way ledge) is rejected', () => {
    const draft = room(20, 20);
    const spawn = { cx: 10, cz: 10 };
    // The spawn sits at the top of a one-way ledge tagged SOUTH: `passable(spawn, fromDir)`
    // only succeeds when fromDir === SOUTH. So a walker CAN step south off the spawn onto the
    // tile below it -- the destination there is plain ground, unaffected by the spawn's own
    // ledge kind, so entering that tile is legal -- but can never step back north off that
    // tile into the spawn, since climbing into a SOUTH-tagged ledge from the south is exactly
    // the direction it forbids. That is "legal to enter, illegal to leave": the south tile
    // must be rejected even though walking onto it from the spawn works fine.
    draft.setCollision(spawn.cx, spawn.cz, 'ledge');
    draft.addTag(spawn.cx, spawn.cz, `ledge:${SOUTH}`);
    const canStep = draft.canStep.bind(draft);

    const tiles = standTiles(spawn, canStep);
    expect(tiles).not.toContainEqual({ cx: 10, cz: 11 }); // south: enterable, not leaveable
    // The one approach whose "leave" direction matches the ledge's own tag (dropping south
    // into the spawn from the north) is the only one left legal both ways.
    expect(tiles).toEqual([{ cx: 10, cz: 9 }]);
  });
});

describe('chooseTarget', () => {
  it('rule 1: rejects a spawn farther than maxManhattan before any pathing is attempted', () => {
    const draft = room(20, 20);
    let calls = 0;
    // Wrapping canStep to count calls proves the prefilter runs before standTiles/aStar ever
    // touch this spawn's geometry -- not just that the end result happens to be null.
    const canStep = (cx, cz, dir) => { calls++; return draft.canStep(cx, cz, dir); };
    const at = { cx: 3, cz: 3 };
    const farSpawn = { cx: 3, cz: 11 }; // manhattan 8 > default maxManhattan 6
    const result = chooseTarget(at, [farSpawn], canStep);
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it('THE HEADLINE CASE: a shorter real path beats a shorter straight-line distance', () => {
    const draft = room(16, 14);
    // A short wall at x=3, blocking only z=4..6 -- everywhere else on that column stays open,
    // so crossing it costs a real detour, not an impossibility.
    for (let z = 4; z <= 6; z++) draft.setCollision(3, z, 'block');
    const canStep = draft.canStep.bind(draft);

    const at = { cx: 2, cz: 5 };
    // Straight-line closer (Manhattan 2) but sits behind the wall: reaching any stand tile
    // means detouring around it.
    const spawnBehindWall = { cx: 4, cz: 5, tag: 'behind-wall' };
    // Straight-line farther (Manhattan 4) but on the walker's own side of the wall, with a
    // clear line of open ground the whole way.
    const spawnOpenGround = { cx: 2, cz: 9, tag: 'open-ground' };

    const manhattanBehind = Math.abs(at.cx - spawnBehindWall.cx) + Math.abs(at.cz - spawnBehindWall.cz);
    const manhattanOpen = Math.abs(at.cx - spawnOpenGround.cx) + Math.abs(at.cz - spawnOpenGround.cz);
    expect(manhattanBehind).toBeLessThan(manhattanOpen); // confirms the map is set up as intended

    const result = chooseTarget(at, [spawnBehindWall, spawnOpenGround], canStep);
    expect(result).not.toBeNull();
    expect(result.spawn.tag).toBe('open-ground'); // the honestly-closer spawn wins

    // And it is not a coincidence of which one got a path at all -- the wall genuinely made
    // the closer-by-ruler spawn's real walk longer than the farther-by-ruler one's.
    const bestPathLength = (spawn) => {
      const tiles = standTiles(spawn, canStep);
      let best = null;
      for (const t of tiles) {
        const p = aStar(at, t, canStep);
        if (p && (!best || p.length < best)) best = p.length;
      }
      return best;
    };
    expect(bestPathLength(spawnOpenGround)).toBeLessThan(bestPathLength(spawnBehindWall));
    expect(result.path.length).toBe(bestPathLength(spawnOpenGround));
  });

  it('rule 3: a path longer than maxSteps is rejected even though the spawn is within maxManhattan', () => {
    const draft = room(10, 16);
    // A long wall at x=3 with the only gap far to the south: the spawn reads Manhattan-close
    // but the honest walk around the wall is well over the default maxSteps budget of 6.
    for (let z = 0; z <= 13; z++) draft.setCollision(3, z, 'block');
    const canStep = draft.canStep.bind(draft);

    const at = { cx: 2, cz: 5 };
    const spawn = { cx: 4, cz: 5 }; // manhattan 2, comfortably inside maxManhattan
    expect(Math.abs(at.cx - spawn.cx) + Math.abs(at.cz - spawn.cz)).toBeLessThanOrEqual(6);

    // Confirm a route exists at all (so this is "too long", not "unreachable")...
    const tiles = standTiles(spawn, canStep);
    const anyPath = tiles.map((t) => aStar(at, t, canStep)).find(Boolean);
    expect(anyPath).toBeTruthy();
    expect(anyPath.length).toBeGreaterThan(6);

    // ...and that chooseTarget rejects it anyway.
    expect(chooseTarget(at, [spawn], canStep)).toBeNull();
  });

  it('rule 4: two spawns tied on path length -- the earlier spawns-array index wins', () => {
    const draft = room(12, 12);
    const canStep = draft.canStep.bind(draft);
    const at = { cx: 5, cz: 5 };
    const spawnLeft = { cx: 2, cz: 5, tag: 'left' };
    const spawnRight = { cx: 8, cz: 5, tag: 'right' };

    // Symmetric around `at`, so both really do produce equal-length paths -- the tie is
    // genuine, not a fluke of one direction being cheaper.
    const bestLen = (spawn) => {
      const tiles = standTiles(spawn, canStep);
      return Math.min(...tiles.map((t) => aStar(at, t, canStep)).filter(Boolean).map((p) => p.length));
    };
    expect(bestLen(spawnLeft)).toBe(bestLen(spawnRight));

    const first = chooseTarget(at, [spawnLeft, spawnRight], canStep);
    expect(first.spawn.tag).toBe('left');
    // Same map, opposite input order -- the winner follows the array, not any inherent
    // "westward" preference.
    const second = chooseTarget(at, [spawnRight, spawnLeft], canStep);
    expect(second.spawn.tag).toBe('right');
  });

  it('never returns a path that steps onto the spawn\'s own cell', () => {
    const draft = room(16, 14);
    for (let z = 4; z <= 6; z++) draft.setCollision(3, z, 'block');
    const canStep = draft.canStep.bind(draft);
    const at = { cx: 2, cz: 5 };
    const spawns = [{ cx: 4, cz: 5 }, { cx: 2, cz: 9 }];

    const result = chooseTarget(at, spawns, canStep);
    expect(result).not.toBeNull();
    for (const step of result.path) {
      expect(step.cx === result.spawn.cx && step.cz === result.spawn.cz).toBe(false);
    }
  });
});
