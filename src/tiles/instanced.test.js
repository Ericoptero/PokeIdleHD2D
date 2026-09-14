/**
 * `cameraFacingRot`'s bit arithmetic (`instanced.js`), pinned in isolation from the
 * InstancedMesh building it feeds — the geometry/material plumbing around it needs a real
 * tileset and is exercised through the flows instead. This is the one place both guards
 * (the `twinDropped` gate and the square-footprint gate) and the new `viewYawQuarter` bit
 * are cheap to check exhaustively, and the one place a regression here would otherwise go
 * unnoticed until a Studio screenshot showed a bare trunk.
 */
import { describe, it, expect } from 'vitest';
import { cameraFacingRot } from './instanced.js';

describe('cameraFacingRot', () => {
  it('at the shipped default (viewYawQuarter omitted), an even rot passes through unchanged', () => {
    expect(cameraFacingRot({ twinDropped: 'x', w: 2, h: 2 }, 0)).toBe(0);
  });

  it('an odd rot still snaps to the nearest even one at yaw quarter 0 — unchanged pre-existing behaviour', () => {
    expect(cameraFacingRot({ twinDropped: 'x', w: 2, h: 2 }, 1, 0)).toBe(0);
  });

  it('yaw quarter 1 ORs its low bit into an even rot', () => {
    expect(cameraFacingRot({ twinDropped: 'x', w: 2, h: 2 }, 0, 1)).toBe(1);
  });

  it('yaw quarter 1 ORs into a 180°-mirrored rot too', () => {
    expect(cameraFacingRot({ twinDropped: 'x', w: 2, h: 2 }, 2, 1)).toBe(3);
  });

  it('a non-square footprint refuses the snap regardless of viewYawQuarter', () => {
    expect(cameraFacingRot({ twinDropped: 'x', w: 3, h: 2 }, 1, 1)).toBe(1);
  });

  it('a model that never dropped its twin passes rot through untouched, ignoring viewYawQuarter', () => {
    expect(cameraFacingRot({ twinDropped: undefined }, 1, 1)).toBe(1);
  });
});
