/**
 * Sprite-sheet geometry and animation tables, measured from the shipped art
 * (ARCHITECTURE §5.5, DECISIONS #4, #17 and #18).
 *
 * Pokemon `assets/overworld/<slug>/{normal,shiny}.png` — 2 columns x 4 rows, always.
 * 1192 sheets are 64x128 (32 px frames); 61 are 128x256 (64 px frames) — Wailord, Steelix,
 * Arceus and the other big bodies. Rows are [north(back), west, south(front), east]; row 1
 * and row 3 are exact horizontal mirrors (checked pixel for pixel: 1024/1024 on every
 * 32 px sheet, 4096/4096 on Rayquaza). Verified by eye on the frame dumps: row 1 faces
 * screen-left, so row 1 is west.
 *
 * Trainer `assets/trainer/{hero,heroine}.png` — 32x768, 24 frames in one column. The
 * grouping in DECISIONS #4 holds, and both of the items it left open are settled here:
 *
 *   (a) sideA = [1,2,3,14,15,16] is WEST. Those frames draw the face, the cap brim and the
 *       shoulder bag on the screen-left side of the sprite; sideB is their exact mirror.
 *       The camera's yaw is fixed looking north, so screen-left is -X, which is west.
 *   (b) Each direction owns six frames: three walk and three run. Within a trio one frame
 *       is the *contact* pose (feet together in profile, feet side by side head-on) and the
 *       other two are the opposite strides. The cycle is contact, stride, contact, stride.
 *
 * How the trios were separated, since the sheet's index order does not group them:
 *   - exact mirrors pair the two profiles:  1-6  2-4  3-5  14-17  15-19  16-18.
 *   - comparing only rows 20..31 (the legs) pairs the same pose across directions:
 *     0-21 (0.43), 9-22 (0.36), 20-23 (0.34) are each other's best match, so north
 *     [0,9,20] and south [21,22,23] are the same three poses seen from behind and in
 *     front. That leaves north [7,8,10] / south [11,12,13] as the other trio.
 *   - the run trio leans into the direction of travel: the alpha centroid of west frames
 *     14,15,16 sits at x 13.8/12.7/14.8 (ahead of centre, facing left) against 16.0/16.2/
 *     16.0 for walk frames 1,2,3, and the run frames are one to two rows shorter.
 *
 * Both answers are proved on screen in docs/progress/pokemon/r1/.
 */

/**
 * Sprite texel density, in texels per world unit.
 *
 * Tiles are authored at 32 px per world unit (DECISIONS #3). The DS overworld sprites are
 * 32 px frames drawn for a 16 px tile, i.e. two tiles tall — so they belong on screen at
 * *half* the tile density, 16 texels per unit, and a 32 px frame spans two world units.
 * That is also what the reference stills show: the creature pixels in
 * docs/refs/03-forest-voxel-night.png are visibly about twice the size of the fence and
 * flower texels behind them. Rendering sprites at 32 texels/unit instead would make a
 * trainer 0.75 tiles tall, which is not the Black & White silhouette.
 */
export const TEXELS_PER_UNIT = 16;

/**
 * Sprites are drawn with two empty rows under the feet: the modal bottom padding of a
 * south-facing frame is 2 texels across the whole set (Pikachu, Mudkip, Riolu, Steelix,
 * Dondozo all measure 2). Dropping the quad by exactly that plants a walking Pokemon on
 * the ground, while the flyers — Zubat 5, Golbat 5, Butterfree 4, Lugia 6 — keep the extra
 * clearance their art was drawn with and go on hovering.
 */
export const FOOT_PAD_TEXELS = 2;

/** core/dir.js direction indices, repeated here so this file stays free of imports. */
const WEST = 1, EAST = 3;

export const POKEMON_SHEET = {
  kind: 'pokemon',
  cols: 2,
  rows: 4,
  /** Sheet row per direction, in core/dir.js order. */
  rowByDir: [2, 1, 0, 3],
  /** Column index of the standing pose. */
  idleCol: 0,
  /** Walk cycle as column indices. Two-frame sheets alternate; there is no separate run. */
  walkCols: [0, 1],
};

export const TRAINER_SHEET = {
  kind: 'trainer',
  width: 32,
  height: 768,
  frame: 32,
  cols: 1,
  rows: 24,
  /** DECISIONS #4's grouping. Identical on hero.png and heroine.png (both checked). */
  framesByDir: {
    north: [0, 7, 8, 9, 10, 20],
    south: [11, 12, 13, 21, 22, 23],
    west: [1, 2, 3, 14, 15, 16],
    east: [4, 5, 6, 17, 18, 19],
  },

  // --- the animation, in core/dir.js order: SOUTH, WEST, NORTH, EAST -------------------
  /** Standing still. Also the contact frame of the walk cycle. East is mirrored from west. */
  idle: [21, 2, 0, null],
  /** Walk: contact, stride, contact, opposite stride. */
  walk: [
    [21, 22, 21, 23],   // south
    [2, 1, 2, 3],       // west
    [0, 9, 0, 20],      // north
    null,               // east
  ],
  /** Run: the leaning trio, same four-phase shape. East is mirrored from west per sheet. */
  run: [
    [11, 12, 11, 13],   // south
    [14, 15, 14, 16],   // west
    [7, 8, 7, 10],      // north
    null,               // east
  ],
};

/**
 * West -> east frame map, **per sheet**. The two trainers group their frames identically —
 * same six back frames, same {1,2,3} / {4,5,6} and {14,15,16} / {17,18,19} mirror sets, same
 * walk and run trios — but they do *not* pair them up in the same order:
 *
 *   hero.png     1↔6  2↔4  3↔5   14↔17  15↔19  16↔18
 *   heroine.png  1↔5  2↔4  3↔6   14↔17  15↔18  16↔19
 *
 * (Both verified pixel for pixel: the mirrored frames are byte-identical.) Applying the
 * hero's map to the heroine would not break her walk, but it would lead with the wrong foot,
 * so the east cycle is derived through the sheet's own map instead of being written out.
 */
export const TRAINER_MIRRORS = {
  hero: { 1: 6, 2: 4, 3: 5, 14: 17, 15: 19, 16: 18 },
  heroine: { 1: 5, 2: 4, 3: 6, 14: 17, 15: 18, 16: 19 },
};

/** Frame index within a Pokemon sheet: row-major over (row, col). */
export const pokemonFrameIndex = (dir, col) => POKEMON_SHEET.rowByDir[dir & 3] * POKEMON_SHEET.cols + col;

/**
 * The Pokemon walk cycle for one direction, as sheet frame indices.
 * Two columns only, so the cycle is simply the two frames alternating.
 */
export function pokemonCycle(dir) {
  return POKEMON_SHEET.walkCols.map((col) => pokemonFrameIndex(dir, col));
}

/**
 * @param {'idle'|'walk'|'run'} gait
 * @param {number} dir  core/dir.js direction
 * @param {'hero'|'heroine'} [who]  which sheet; only the east cycle differs between them
 * @returns {number[]} sheet frame indices, in play order
 */
export function trainerCycle(gait, dir, who = 'hero') {
  const d = dir & 3;
  const table = gait === 'run' ? TRAINER_SHEET.run
    : gait === 'walk' ? TRAINER_SHEET.walk
      : TRAINER_SHEET.walk.map((c) => (c ? [c[0]] : null));
  if (d !== EAST) return table[d];
  const mirror = TRAINER_MIRRORS[who] ?? TRAINER_MIRRORS.hero;
  return table[WEST].map((f) => mirror[f] ?? f);
}

/**
 * Layout of a sheet given only the image size. Every Pokemon sheet is 2 columns x 4 rows;
 * the trainer is 1 column x 24 rows. Both are inferred, so a sheet we have not seen still
 * lands in the atlas correctly.
 */
export function sheetLayout(kind, width, height) {
  if (kind === 'trainer') {
    return { cols: 1, rows: height / width, frame: width, count: height / width };
  }
  const frame = width / POKEMON_SHEET.cols;
  return { cols: POKEMON_SHEET.cols, rows: POKEMON_SHEET.rows, frame, count: POKEMON_SHEET.cols * POKEMON_SHEET.rows };
}

/**
 * World size of one frame.
 *
 * `width` is the frame's texel width over the sprite texel density. `height` is stretched
 * by 1/cos(pitch) because the billboard stands upright in a world seen from 45 degrees
 * above: a vertical world unit only covers cos(pitch) of the screen height it would cover
 * face-on, so an unstretched quad renders the art squashed to 71 % and its texels stop
 * being square. With the stretch a 32x32 frame lands on screen as a square block of pixels,
 * which is the whole point of the pixel grid.
 */
export function frameWorldSize(frameTexels, pitchDeg = 45) {
  const w = frameTexels / TEXELS_PER_UNIT;
  const h = w / Math.cos((pitchDeg * Math.PI) / 180);
  return { w, h };
}
