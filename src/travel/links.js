/**
 * links.js — pure matching logic for a map's authored `Link[]` (src/travel/index.js).
 *
 * A `.map.json` file can now carry its own `links[]` — the doors, map edges and staircases
 * that used to be one-off, hardcoded mechanisms (the Pokemon Center's old `door:pokecenter`
 * tag pair is the example this slice replaces: see `src/pokecenter/index.js`'s header for what
 * it used to say). `travel/index.js` reads `terrain.report()?.links` off whichever map is
 * currently loaded and asks this module, on every `player:enteredTile`, whether the cell the
 * player's head just stepped onto matches one of them.
 *
 * Kept out of `travel/index.js` itself and free of `ctx`/`bus`/any import beyond a types-only
 * JSDoc: the anti-ping-pong rule below is fiddly enough — a warp can land the player on a cell
 * that is itself another link's own trigger — that it deserves tests run against plain objects,
 * not a stubbed registry. This file only answers the pure question "does this landing cell
 * match a link, given what the caller currently believes about a just-completed arrival"; the
 * *stateful* half — deciding when that belief is set and cleared — belongs to `travel/index.js`,
 * which is the only thing that knows when a `go()` it kicked off has actually settled.
 *
 * @typedef {{id:string, kind:'door'|'edge'|'stairs', from:{cx:number,cz:number},
 *   to:{map:string, marker?:string, cx?:number, cz?:number, dir?:0|1|2|3}, label?:string}} Link
 */

/**
 * @param {Link[]} links  the current map's links (`terrain.report()?.links ?? []`)
 * @param {{cx:number, cz:number, tags?:string[]}} landing  the cell just stepped onto
 * @param {{justArrivedAt: {cx:number,cz:number}|null}} state
 * @returns {Link|null} the matching link, or `null`
 */
export function linkAt(links, landing, state) {
  if (!Array.isArray(links) || !links.length) return null;

  // The anti-ping-pong guard. A warp's own destination cell can happen to be some link's own
  // `from` — two rooms sharing a doorway is the obvious case, but even a single room can do it
  // if its exit marker sits one cell off from where the matching entry link expects the player
  // to land — and without this, the very `player:enteredTile` the arrival teleport itself
  // produces would immediately fire a second link right back. `justArrivedAt` is the caller's
  // record of "this is the cell my last successful warp put the player on"; once the player has
  // taken any further step the caller clears it (see `travel/index.js`), so this only ever
  // suppresses the one landing cell, once.
  if (state?.justArrivedAt
    && state.justArrivedAt.cx === landing.cx
    && state.justArrivedAt.cz === landing.cz) return null;

  // First match wins. Two links sharing a `from` cell is not a shape the Studio's authoring
  // tools should ever produce — a door only leads one place — but by the time a `.map.json`
  // file reaches this function it is untrusted input, and a malformed file should make travel
  // pick one door rather than throw and take the whole room down with it.
  return links.find((link) => link?.from?.cx === landing.cx && link?.from?.cz === landing.cz) ?? null;
}
