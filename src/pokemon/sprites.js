/**
 * Sprite-sheet geometry, verified against the shipped art (ARCHITECTURE §5.5).
 *
 * Pokemon: 64x128, 32px frames, 2 columns x 4 rows. Row order is [north, west, south, east];
 * rows 1 and 3 are exact horizontal mirrors (checked: 1024/1024 pixels), which is the
 * signature of a left/right pair. Columns are the two-frame walk cycle.
 *
 * Trainer: 32x768, 24 frames in one column. The direction grouping below was derived from
 * the sheet itself — the six back-facing frames are unambiguous (4-8 skin pixels against
 * 18-24 for every other frame) and the side frames fall into two exact mirror sets.
 *
 * OPEN (DECISIONS #4): which mirror set is west is not decided by the pixels alone. The
 * pokemon builder must walk the trainer left on screen and confirm, then delete this note.
 */

export const FRAME = 32;

export const SHEET = {
  pokemon: {
    width: 64, height: 128, frame: 32, cols: 2, rows: 4,
    // row index per direction, in core/dir.js order: SOUTH, WEST, NORTH, EAST
    rowByDir: [2, 1, 0, 3],
    walk: [0, 1],
  },
  trainer: {
    width: 32, height: 768, frame: 32, cols: 1, rows: 24,
    framesByDir: {
      north: [0, 7, 8, 9, 10, 20],
      south: [11, 12, 13, 21, 22, 23],
      sideA: [1, 2, 3, 14, 15, 16],
      sideB: [4, 5, 6, 17, 18, 19],
    },
    mirrors: [[1, 6], [2, 4], [3, 5], [14, 17], [15, 19], [16, 18]],
  },
};

/**
 * UV rect for one frame of a sheet, in three.js texture space (origin bottom-left).
 * @returns {{u:number, v:number, w:number, h:number}}
 */
export function frameUv(sheet, col, row) {
  const w = sheet.frame / sheet.width;
  const h = sheet.frame / sheet.height;
  return { u: col * w, v: 1 - (row + 1) * h, w, h };
}

/** The four directions of a Pokemon sheet, each as an array of walk-cycle UV rects. */
export function spriteFrames(sheet = SHEET.pokemon) {
  return sheet.rowByDir.map((row) => sheet.walk.map((col) => frameUv(sheet, col, row)));
}
