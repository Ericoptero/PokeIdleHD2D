/**
 * The conga line — the grid walker itself, with no renderer, no ctx and no three.js in it.
 *
 * The brief inverts the usual follower arrangement: the **active Pokemon leads** and the
 * **trainer follows it**, occupying the cell the lead stood on `gap` steps ago. Everything
 * behind the trainer trails in the same queue. So the line is a single *trail of cells* and
 * every walker is an index into it:
 *
 *      trail  [ 0 ][ 1 ][ 2 ][ 3 ][ 4 ] …           newest cell first
 *      slot     ^lead     ^trainer    ^party[1]     slot = member * gap
 *
 * Slot `k` renders between `trail[k+1]` (where it was) and `trail[k]` (where it is going),
 * which is what makes the motion tile-locked: a walker starts a step on a cell and finishes
 * it on a cell, and the whole queue moves in lockstep so the spacing never breathes.
 *
 * `trail[k].dir` is the direction a walker was travelling when it *entered* that cell, which
 * is the direction it must face while walking into it. The head is the one exception — it can
 * turn on the spot without moving — so its facing is carried separately in `facing`.
 *
 * Determinism: `t` only ever advances by `dt / secondsPerTile`, and the one cadence divides
 * the 1/20 s sim step exactly (0.25 s = 5 steps), so the same input at the same seed lands on
 * the same cells at the same sub-tile offsets forever. The leftover of a step that would
 * overshoot is carried into the next one rather than dropped.
 */

import { DIR_DX, DIR_DZ, SOUTH } from '../core/dir.js';

/** Cells kept behind the head. A six-member line at gap 3 needs 17; 64 is free insurance. */
export const TRAIL_MAX = 64;

export class Line {
  /**
   * @param {object} [opts]
   * @param {number} [opts.gap]     cells between consecutive members
   * @param {number} [opts.members] how many walkers are in the queue
   */
  constructor({ gap = 1, members = 2 } = {}) {
    this.gap = Math.max(1, Math.round(gap) || 1);
    this.members = Math.max(1, Math.round(members) || 1);
    /** @type {{cx:number, cz:number, dir:number}[]} newest first; trail[0] is the head. */
    this.trail = [{ cx: 0, cz: 0, dir: SOUTH }];
    this.facing = SOUTH;
    this.moving = false;
    this.secondsPerTile = 0.25;
    /** Progress through the current step, 0..1. */
    this.t = 1;
    /** Overshoot carried out of the last step, so a ragged dt cannot shorten a tile. */
    this.carry = 0;
    /** Completed steps — the odometer the walk cycle is keyed to. */
    this.steps = 0;
    /** Simulated seconds; frozen with the sim, so idle animation freezes with everything. */
    this.animTime = 0;
  }

  /** Trail entries needed to place and interpolate every member. */
  get depth() { return this.gap * (this.members - 1) + 2; }

  /** Distance walked in tiles, including the fraction of the step in progress. */
  get distance() { return this.steps + (this.moving ? this.t : 0); }

  /** Cell of member `i` (0 = the lead), i.e. where it is standing or heading. */
  cellOf(i) { return this.trail[Math.min(i * this.gap, this.trail.length - 1)]; }

  /**
   * Lays the whole queue out in a straight line through `(cx, cz)`, which is member
   * `anchor`'s cell. Members ahead of the anchor are placed forward along `dir`, members
   * behind it backward; a cell that fails `passable` stacks on its neighbour rather than
   * putting a walker inside a wall.
   *
   * @param {number} anchor  member index the coordinates belong to (the trainer, normally)
   * @param {(cx:number, cz:number, dir:number) => boolean} passable
   */
  place(anchor, cx, cz, dir = SOUTH, passable = () => true) {
    const slot = Math.max(0, Math.min(this.members - 1, anchor)) * this.gap;
    const need = Math.max(this.depth, slot + 2);
    const cells = new Array(need);
    cells[slot] = { cx, cz, dir };
    for (let k = slot - 1; k >= 0; k--) {
      const from = cells[k + 1];
      const nx = from.cx + DIR_DX[dir], nz = from.cz + DIR_DZ[dir];
      cells[k] = passable(nx, nz, dir) ? { cx: nx, cz: nz, dir } : { ...from };
    }
    for (let k = slot + 1; k < need; k++) {
      const from = cells[k - 1];
      const bx = from.cx - DIR_DX[dir], bz = from.cz - DIR_DZ[dir];
      cells[k] = passable(bx, bz, dir) ? { cx: bx, cz: bz, dir } : { ...from };
    }
    this.trail = cells;
    this.facing = dir;
    this.moving = false;
    this.t = 1;
    this.carry = 0;
    this.steps = 0;
    return this;
  }

  /** Grows or shrinks the queue without disturbing the cells anyone is standing on. */
  setMembers(n) {
    this.members = Math.max(1, Math.round(n) || 1);
    while (this.trail.length < this.depth) {
      const tail = this.trail[this.trail.length - 1];
      this.trail.push({ ...tail });
    }
    return this;
  }

  /** Turns the head on the spot. Followers keep the facing their own cell recorded. */
  turn(dir) { this.facing = dir & 3; }

  /**
   * Starts one step of the head in `dir`. The head always turns to face `dir`, even when the
   * cell ahead is blocked — walking into a wall in Black & White turns you, it does not
   * freeze you.
   *
   * @returns {boolean} true if the queue actually moved
   */
  step(dir, { walkSeconds = 0.25, passable = () => true } = {}) {
    const d = dir & 3;
    this.facing = d;
    if (this.moving) return false;
    const head = this.trail[0];
    const nx = head.cx + DIR_DX[d], nz = head.cz + DIR_DZ[d];
    if (!passable(nx, nz, d)) return false;

    // A 180-degree turn walks the head into the cell the walker behind it is standing on, and
    // the queue then passes through itself one member at a time until the trail is straight
    // again — `gap · members` steps later. That is deliberately *not* special-cased: it is
    // what the mainline games do when you turn round into your follower, and every
    // alternative either teleports a member several cells or leaves the lead at the back of
    // its own queue. `route.js` keeps reversals rare instead, which is the right layer for it.
    this.trail.unshift({ cx: nx, cz: nz, dir: d });
    if (this.trail.length > TRAIL_MAX) this.trail.length = TRAIL_MAX;
    this.moving = true;
    this.secondsPerTile = Math.max(0.01, walkSeconds);
    this.t = Math.min(0.999, this.carry);
    this.carry = 0;
    return true;
  }

  /**
   * Advances the step in progress.
   * @returns {boolean} true on the tick the queue lands on its new cells
   */
  advance(dt) {
    this.animTime += dt;
    if (!this.moving) return false;
    this.t += dt / this.secondsPerTile;
    if (this.t < 1) return false;
    this.carry = this.t - 1;
    this.t = 1;
    this.moving = false;
    this.steps++;
    return true;
  }

  /**
   * Interpolated pose of member `i`.
   *
   * @param {number} i
   * @param {number} [sub] extra fraction of a step, for rendering between fixed sim ticks.
   *   Pass 0 when the sim is frozen or the pose stops being reproducible.
   * @returns {{x:number, z:number, cx:number, cz:number, fromX:number, fromZ:number,
   *            t:number, dir:number, moving:boolean}} `x`/`z` are cell centres in world space.
   */
  pose(i, sub = 0) {
    const k = Math.min(i * this.gap, this.trail.length - 1);
    const to = this.trail[k];
    const from = this.trail[Math.min(k + 1, this.trail.length - 1)];
    const t = this.moving ? Math.min(1, this.t + sub) : 1;
    return {
      x: from.cx + (to.cx - from.cx) * t + 0.5,
      z: from.cz + (to.cz - from.cz) * t + 0.5,
      cx: to.cx, cz: to.cz,
      fromX: from.cx, fromZ: from.cz,
      t,
      dir: k === 0 ? this.facing : to.dir,
      moving: this.moving,
    };
  }
}
