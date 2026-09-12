/**
 * The Pokemon Center's interior, as data.
 *
 * One small room, composed from real tileset geometry the way `city/layout.js` composes the
 * town: the numbers live here, `map.js` paints the base tileset (`pt-house-indoor`) and
 * reserves the footprints the *other* two tilesets fill in, and `dress.js` builds those other
 * two as their own `InstancedWorld`s (a `Placement` names a model id and `buildInstances`
 * resolves it against exactly one tileset, DECISIONS #26a — the same constraint `city`'s
 * buildings and props are under).
 *
 * The room is a **three-walled box**, deliberately. The fixed 45-degree camera looks down
 * into the room from roughly the south, and a real south wall would stand between the lens
 * and everything the room is for — the same arithmetic `hunts/biomes/cave.js` states for why
 * its rock has no ceiling: a camera that cannot see a ceiling from below cannot see a near
 * wall from outside either. Collision still closes the room on that side (`MapDraft`'s
 * cells default to `'block'`, `terrain/draft.js`): only the door tile is walkable there.
 */

import { SOUTH, NORTH } from '../core/dir.js';

/**
 * Cells, not metres. Odd width centres a 3-wide fixture (the window, the counter) exactly.
 *
 * Sized against the fixed camera's own arithmetic (`city/layout.js`'s header): at 16:9 it
 * sees roughly x ±12.5 and z −12.7…+8.0 around its focus, and the focus is the trainer. A
 * first pass at 9x7 sat inside barely a third of that box — a lit stage in a large black
 * void, `enclosed:1`'s sky having nothing outdoors to hide it behind. 13x10 fills most of
 * the frame's width without threatening the ±12.5 the corners would clip at.
 */
export const ROOM_W = 13;
export const ROOM_H = 10;

/** The tileset every floor, wall and counter placement in `map.js` comes from. */
export const TILESET = 'pt-house-indoor';

/**
 * The door tile back in the city, and where this room's own door tile is.
 *
 * `EXIT` sits on the room's south edge, the one wall this room does not build — see the
 * file header. `SPAWN` is one cell north of it, facing further into the room (north, at the
 * counter): a player who has just walked in through the door is standing where they landed,
 * looking at the thing they came here for.
 */
export const EXIT = { cx: 6, cz: ROOM_H - 1 };
export const SPAWN = { cx: EXIT.cx, cz: EXIT.cz - 1, dir: NORTH };

/** The tag `map.js` puts on `EXIT` and `index.js` listens for to leave the room. */
export const EXIT_TAG = 'door:pokecenter-exit';

/**
 * Facing away from the building once back on the pavement (`core/dir.js`'s `SOUTH`) — the
 * `party:wiped` teleport in `travel/index.js` lands the same cell facing `NORTH`, into the
 * door, because that is a fainted party arriving to be healed. A player who just walked out
 * on their own has already seen the counter; they are facing back the way they came.
 */
export const RETURN_DIR = SOUTH;

/**
 * The counter (the pack's one furniture piece, `table` — id 70, `subcategory:'table'`,
 * 3x1, `collision:'block'`) and the window above it (`hgss-newbark-houses`' `window`, the
 * only window geometry in the project, also 3x1). Sharing an x-span is deliberate
 * composition, not a coincidence of the pack: daylight falls on the thing the room is for.
 */
export const WINDOW = { cx: 5, cz: 0, w: 3 };
export const COUNTER = { cx: 5, cz: 2, w: 3 };

/** `bw2-adastra`'s `bench_e`/`bench_w` (DECISIONS #6 tags: `bench, seat`), flanking the open
 *  floor between the door and the counter. */
export const BENCHES = [
  { cx: 2, cz: 5, face: 'e' },
  { cx: ROOM_W - 3, cz: 5, face: 'w' },
];

/** How the room is played (`simulation.setFormation`) — the trainer drives, same as `city`. */
export const FORMATION = { head: 'trainer', input: true, autopilot: 'none' };

/** Named camera framings the screenshot harness can request (ARCHITECTURE §8). */
export const PRESETS = {
  default: { cx: SPAWN.cx, cz: SPAWN.cz },
  counter: { cx: COUNTER.cx + 1, cz: COUNTER.cz + 1 },
};
