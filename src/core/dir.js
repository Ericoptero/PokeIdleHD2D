// @ts-check
/** The four grid directions. Fixed forever — saves and sprite sheets index by these. */
export const SOUTH = 0, WEST = 1, NORTH = 2, EAST = 3;

export const DIRS = [SOUTH, WEST, NORTH, EAST];
export const DIR_NAME = ['south', 'west', 'north', 'east'];

/** Cell delta per direction, in engine axes: +x east, +z south (ARCHITECTURE §3). */
export const DIR_DX = [0, -1, 0, 1];
export const DIR_DZ = [1, 0, -1, 0];

/** Yaw in radians for a sprite or mesh facing that direction (0 = facing +z / south). */
export const DIR_YAW = [0, Math.PI * 0.5, Math.PI, -Math.PI * 0.5];

export const opposite = (d) => (d + 2) & 3;
export const turnRight = (d) => (d + 3) & 3;
export const turnLeft = (d) => (d + 1) & 3;

/** Direction that points from (ax,az) toward (bx,bz); ties resolve to the larger axis. */
export function dirTo(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? EAST : WEST;
  return dz >= 0 ? SOUTH : NORTH;
}
